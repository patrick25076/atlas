// Server-only. Open, key-free "what's on" feeds published by cities (docs/events-sources.md,
// verified 2026-10-10). Three adapter families cover most of them: Opendatasoft Explore v2.1,
// Socrata SoQL and Linked Events; a few cities have their own shape. Each source knows where
// it is, so the route picks the ones near a place. Every fetch is cached six hours.
import { haversineKm } from "../geo";

export type EventItem = {
  name: string;
  /** ISO date (YYYY-MM-DD) of the first upcoming occurrence. */
  date: string;
  end?: string;
  venue?: string;
  kind?: string;
  url: string;
  image?: string;
  lat?: number;
  lon?: number;
  free?: boolean;
  source: string;
};

export type Source = {
  id: string;
  city: string;
  lat: number;
  lon: number;
  licence: string;
  attribution: string;
  /** Rough reach of the feed, km. */
  radiusKm?: number;
  fetch: (from: string, to: string) => Promise<EventItem[]>;
};

const UA = "atlas travel globe (https://github.com/patrick25076/atlas)";
const REVALIDATE = 6 * 3600;

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T | null> {
  try {
    const r = await fetch(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...(init.headers ?? {}) }, next: { revalidate: REVALIDATE } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

const day = (s: string | undefined | null): string | undefined => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? (/^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined) : d.toISOString().slice(0, 10);
};
const strip = (html: string | undefined | null): string => (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const firstStr = (v: unknown): string | undefined => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined);

/** Words that mark the noise in municipal feeds: meetings, leagues, classes, permits. */
const NOISE =
  /\b(council|committee|board meeting|public hearing|league|tryout|registration|permit|construction|fitness|zumba|yoga|pilates|swim(ming)? lesson|toddler|storytime|story time|homework|knitting|babytime|tax clinic|blood drive|vaccin|training|practice|liikunta|jalkapallo|jääkiekko|jumppa|jumppi|kuntosali|uinti|lentopallo|koripallo|salibandy|treeni|harjoitus|hockey|basketball|volleyball|soccer practice|bootcamp|boot camp|parkrun|maintenance|closed|closure|contract work|roadwork)/i;
export const isNoise = (name: string, kind?: string) => NOISE.test(`${name} ${kind ?? ""}`);

type OdsRow = Record<string, unknown>;
/** Opendatasoft Explore v2.1: one adapter, seven cities. */
function ods(id: string, city: string, lat: number, lon: number, licence: string, base: string, dataset: string, dateField: string, map: (r: OdsRow) => EventItem | null): Source {
  return {
    id,
    city,
    lat,
    lon,
    licence,
    attribution: `${city} open data`,
    fetch: async (from, to) => {
      const where = encodeURIComponent(`${dateField}>="${from}" AND ${dateField}<="${to}"`);
      const j = await getJson<{ results?: OdsRow[] }>(`${base}/api/explore/v2.1/catalog/datasets/${dataset}/records?limit=100&where=${where}&order_by=${dateField}`);
      return (j?.results ?? []).map(map).filter((x): x is EventItem => !!x);
    },
  };
}

type SocRow = Record<string, unknown>;
/** Socrata SoQL: one adapter, five cities. */
function socrata(id: string, city: string, lat: number, lon: number, licence: string, base: string, resource: string, dateField: string, map: (r: SocRow) => EventItem | null, extraWhere = ""): Source {
  return {
    id,
    city,
    lat,
    lon,
    licence,
    attribution: `${city} open data`,
    fetch: async (from, to) => {
      const where = encodeURIComponent(`${dateField}>='${from}' AND ${dateField}<='${to}T23:59:59'${extraWhere}`);
      const j = await getJson<SocRow[]>(`${base}/resource/${resource}.json?$limit=300&$order=${dateField}&$where=${where}`);
      return (j ?? []).map(map).filter((x): x is EventItem => !!x);
    },
  };
}

type LEvent = { name?: Record<string, string>; start_time?: string; end_time?: string; info_url?: string; images?: { url: string }[]; location?: { name?: Record<string, string>; position?: { coordinates?: [number, number] } }; keywords?: { name?: Record<string, string> }[]; offers?: { is_free?: boolean }[]; id?: string };
/** Linked Events (Helsinki, Espoo). */
function linkedEvents(id: string, city: string, lat: number, lon: number, base: string, site: string): Source {
  return {
    id,
    city,
    lat,
    lon,
    licence: "CC BY 4.0",
    attribution: `${city} Linked Events`,
    fetch: async (from, to) => {
      const j = await getJson<{ data?: LEvent[] }>(`${base}/event/?start=${from}&end=${to}&page_size=100&include=location,keywords&sort=start_time&super_event_type=none`);
      return (j?.data ?? []).map((e): EventItem | null => {
        const name = e.name?.en ?? e.name?.fi ?? e.name?.sv;
        const date = day(e.start_time);
        if (!name || !date) return null;
        const coords = e.location?.position?.coordinates;
        return {
          name,
          date,
          end: day(e.end_time),
          venue: e.location?.name?.en ?? e.location?.name?.fi,
          kind: e.keywords?.[0]?.name?.en ?? e.keywords?.[0]?.name?.fi,
          url: e.info_url || (e.id ? `${site}/${e.id}` : site),
          image: e.images?.[0]?.url,
          lon: coords?.[0],
          lat: coords?.[1],
          free: e.offers?.[0]?.is_free,
          source: id,
        };
      }).filter((x): x is EventItem => !!x);
    },
  };
}

const str = (r: Record<string, unknown>, k: string) => (typeof r[k] === "string" ? (r[k] as string) : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : undefined);
const geo = (v: unknown): { lat?: number; lon?: number } => {
  const g = v as { lat?: number; lon?: number } | undefined;
  return g && typeof g.lat === "number" ? { lat: g.lat, lon: g.lon } : {};
};

export const SOURCES: Source[] = [
  ods("paris", "Paris", 48.8566, 2.3522, "ODbL", "https://opendata.paris.fr", "que-faire-a-paris-", "date_start", (r) => {
    const name = str(r, "title");
    const date = day(str(r, "date_start"));
    if (!name || !date) return null;
    return { name, date, end: day(str(r, "date_end")), venue: str(r, "address_name"), kind: firstStr(r.tags) ?? str(r, "category"), url: str(r, "url") ?? "https://quefaire.paris.fr", image: str(r, "cover_url"), ...geo(r.lat_lon), free: str(r, "price_type") === "gratuit", source: "paris" };
  }),
  ods("bordeaux", "Bordeaux", 44.8378, -0.5792, "Licence Ouverte", "https://opendata.bordeaux-metropole.fr", "met_agenda", "firstdate_begin", (r) => {
    const name = str(r, "title_fr");
    const date = day(str(r, "firstdate_begin"));
    if (!name || !date) return null;
    return { name, date, end: day(str(r, "lastdate_end")), venue: str(r, "location_name"), kind: firstStr(r.keywords_fr), url: str(r, "canonicalurl") ?? "https://openagenda.com", image: str(r, "image") ?? str(r, "location_image"), ...geo(r.location_coordinates), source: "bordeaux" };
  }),
  ods("nantes", "Nantes", 47.2184, -1.5536, "Licence Ouverte", "https://data.nantesmetropole.fr", "244400404_agenda-evenements-nantes-metropole_v2", "date", (r) => {
    const name = str(r, "nom");
    const date = day(str(r, "date"));
    if (!name || !date) return null;
    return { name, date, venue: str(r, "lieu"), kind: firstStr(r.types_libelles) ?? str(r, "types_libelles"), url: str(r, "url_site") ?? str(r, "lien_agenda") ?? "https://metropole.nantes.fr/agenda", image: str(r, "media_url"), ...geo(r.location_latlong), free: str(r, "gratuit") === "oui", source: "nantes" };
  }),
  ods("bologna", "Bologna", 44.4949, 11.3426, "CC BY 4.0", "https://opendata.comune.bologna.it", "eventi-bologna-agenda-cultura", "start", (r) => {
    const name = str(r, "title");
    const date = day(str(r, "start"));
    if (!name || !date) return null;
    return { name, date, end: day(str(r, "end")), venue: str(r, "address"), kind: str(r, "categories_1"), url: str(r, "url") ?? "https://culturabologna.it", ...geo(r.coordinate), source: "bologna" };
  }),
  ods("ghent", "Ghent", 51.0543, 3.7174, "Flemish free reuse licence", "https://data.stad.gent", "toeristische-evenementen-visit-gent", "date_start", (r) => {
    const name = str(r, "name_nl") ?? str(r, "name_en");
    const date = day(str(r, "date_start"));
    if (!name || !date) return null;
    return { name, date, end: day(str(r, "date_end")), venue: str(r, "ctcname_nl"), url: str(r, "url") ?? "https://visit.gent.be", ...geo(r.geo), source: "ghent" };
  }),
  ods("brisbane", "Brisbane", -27.4698, 153.0251, "CC BY 4.0", "https://data.brisbane.qld.gov.au", "brisbane-city-council-events", "start_datetime", (r) => {
    const name = str(r, "subject");
    const date = day(str(r, "start_datetime"));
    if (!name || !date) return null;
    return { name, date, end: day(str(r, "end_datetime")), venue: str(r, "venue"), kind: str(r, "primaryeventtype") ?? firstStr(r.event_type), url: str(r, "web_link") ?? "https://www.brisbane.qld.gov.au/whats-on-and-events", image: str(r, "eventimage"), ...geo(r.geolocation), free: /free/i.test(str(r, "cost") ?? ""), source: "brisbane" };
  }),
  ods("basel", "Basel", 47.5596, 7.5886, "CC BY 4.0", "https://data.bs.ch", "100419", "datum", (r) => {
    const name = str(r, "name");
    const date = day(str(r, "datum"));
    if (!name || !date) return null;
    return { name, date, venue: str(r, "ort"), url: str(r, "link") ?? "https://data.bs.ch", source: "basel" };
  }),
  linkedEvents("helsinki", "Helsinki", 60.1699, 24.9384, "https://api.hel.fi/linkedevents/v1", "https://tapahtumat.hel.fi/en/events"),
  linkedEvents("espoo", "Espoo", 60.2055, 24.6559, "https://api.espoo.fi/events/v1", "https://tapahtumat.espoo.fi/en/events"),
  socrata("nyc", "New York", 40.7128, -74.006, "NYC Open Data terms", "https://data.cityofnewyork.us", "tvpp-9vvx", "start_date_time", (r) => {
    const name = str(r, "event_name");
    const date = day(str(r, "start_date_time"));
    const kind = str(r, "event_type");
    if (!name || !date) return null;
    if (!/street fair|farmers market|special event|parade|festival|film|concert|market/i.test(kind ?? "")) return null;
    return { name, date, end: day(str(r, "end_date_time")), venue: str(r, "event_location")?.slice(0, 80), kind, url: "https://www.nyc.gov/events", source: "nyc" };
  }),
  socrata("chicago", "Chicago", 41.8781, -87.6298, "Chicago Data Portal terms", "https://data.cityofchicago.org", "vsdy-d8k7", "start", (r) => {
    const name = str(r, "title");
    const date = day(str(r, "start"));
    if (!name || !date) return null;
    const link = (r.event_page as { url?: string } | undefined)?.url;
    const loc = r.location as { coordinates?: [number, number] } | undefined;
    return { name, date, end: day(str(r, "end")), venue: str(r, "location_name"), kind: firstStr(r.event_types) ?? str(r, "event_types"), url: link ?? "https://www.chipublib.org/events/", lon: loc?.coordinates?.[0], lat: loc?.coordinates?.[1], free: true, source: "chicago" };
  }),
  socrata("sf", "San Francisco", 37.7749, -122.4194, "PDDL", "https://data.sfgov.org", "8i3s-ih2a", "event_start_date", (r) => {
    const name = str(r, "event_name");
    const date = day(str(r, "event_start_date"));
    if (!name || !date) return null;
    return { name, date, end: day(str(r, "event_end_date")), venue: str(r, "site_location_name"), kind: str(r, "events_category"), url: str(r, "more_info") ?? "https://our415.org", image: (r.event_photo as { url?: string } | undefined)?.url, lat: num(r.latitude), lon: num(r.longitude), free: /free|none|0/i.test(str(r, "fee") ?? ""), source: "sf" };
  }),
  socrata("calgary", "Calgary", 51.0447, -114.0719, "OGL Calgary", "https://data.calgary.ca", "n625-9k5x", "next_date_times", (r) => {
    const name = str(r, "title");
    if (!name) return null;
    const m = str(r, "next_date_times")?.match(/\d{4}-\d{2}-\d{2}/);
    if (!m) return null;
    return { name, date: m[0], venue: str(r, "address"), kind: str(r, "event_type"), url: str(r, "more_info_url") ?? "https://www.calgary.ca/events.html", lat: num(r.latitude), lon: num(r.longitude), source: "calgary" };
  }),
  socrata("edmonton", "Edmonton", 53.5461, -113.4938, "Edmonton open data terms", "https://data.edmonton.ca", "64u3-c7bh", "begins", (r) => {
    const name = str(r, "title");
    const date = day(str(r, "begins"));
    if (!name || !date) return null;
    return { name, date, end: day(str(r, "ends")), venue: str(r, "event_venue"), kind: str(r, "event_type"), url: (r.event_link as { url?: string } | undefined)?.url ?? "https://www.edmonton.ca/attractions_events", lat: num(r.latitude), lon: num(r.longitude), source: "edmonton" };
  }),
  {
    id: "madrid",
    city: "Madrid",
    lat: 40.4168,
    lon: -3.7038,
    licence: "CC BY 4.0",
    attribution: "Ayuntamiento de Madrid, datos.madrid.es",
    fetch: async (from, to) => {
      const j = await getJson<{ "@graph"?: Record<string, unknown>[] }>("https://datos.madrid.es/egob/catalogo/206974-0-agenda-eventos-culturales-100.json");
      return (j?.["@graph"] ?? [])
        .map((r): EventItem | null => {
          const name = str(r, "title");
          const date = day(str(r, "dtstart"));
          if (!name || !date || date < from || date > to) return null;
          const loc = r.location as { latitude?: number; longitude?: number } | undefined;
          const type = str(r, "@type")?.split("/").pop()?.replace(/([a-z])([A-Z])/g, "$1 $2");
          return { name, date, end: day(str(r, "dtend")), venue: str(r, "event-location"), kind: type, url: str(r, "link") ?? "https://www.madrid.es", lat: loc?.latitude, lon: loc?.longitude, free: r.free === 1, source: "madrid" };
        })
        .filter((x): x is EventItem => !!x);
    },
  },
  {
    id: "lisbon",
    city: "Lisbon",
    lat: 38.7223,
    lon: -9.1393,
    licence: "CC BY 4.0",
    attribution: "Agenda Cultural de Lisboa (Câmara Municipal de Lisboa)",
    fetch: async (from, to) => {
      const j = await getJson<Record<string, unknown>[]>("https://www.agendalx.pt/wp-json/agendalx/v1/events?per_page=100&page=1");
      return (j ?? [])
        .map((r): EventItem | null => {
          const title = (r.title as { rendered?: string } | undefined)?.rendered;
          const name = strip(title);
          const date = day(str(r, "StartDate"));
          if (!name || !date) return null;
          const end = day(str(r, "LastDate"));
          if ((end ?? date) < from || date > to) return null;
          const venue = Object.values((r.venue as Record<string, { name?: string }> | undefined) ?? {})[0]?.name;
          return { name, date: date < from ? from : date, end, venue, kind: firstStr(r.categories_name_list), url: str(r, "link") ?? "https://www.agendalx.pt", image: str(r, "featured_media_large"), free: str(r, "price_cat") === "free", source: "lisbon" };
        })
        .filter((x): x is EventItem => !!x);
    },
  },
  {
    id: "berlin",
    city: "Berlin",
    lat: 52.52,
    lon: 13.405,
    licence: "CC BY",
    attribution: "Land Berlin, berlin.de",
    fetch: async (from, to) => {
      const urls = ["https://www.berlin.de/sen/web/service/maerkte-feste/strassen-volksfeste/index.php/index/all.json", "https://www.berlin.de/sen/web/service/maerkte-feste/weihnachtsmaerkte/index.php/index/all.json"];
      const out: EventItem[] = [];
      for (const u of urls) {
        const j = await getJson<{ index?: Record<string, unknown>[] }>(u);
        for (const r of j?.index ?? []) {
          const name = str(r, "bezeichnung") ?? str(r, "name");
          const de = (s?: string) => {
            const m = s?.match(/(\d{2})\.(\d{2})\.(\d{4})/);
            return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
          };
          const date = de(str(r, "von"));
          const end = de(str(r, "bis"));
          if (!name || !date || (end ?? date) < from || date > to) continue;
          out.push({ name, date: date < from ? from : date, end, venue: [str(r, "strasse"), str(r, "bezirk")].filter(Boolean).join(", "), kind: u.includes("weihnachts") ? "Christmas market" : "street fair", url: str(r, "www") || "https://www.berlin.de/sen/web/service/maerkte-feste/", free: true, source: "berlin" });
        }
      }
      return out;
    },
  },
  {
    id: "ireland",
    city: "Dublin",
    lat: 53.3498,
    lon: -6.2603,
    licence: "CC BY 4.0",
    attribution: "Fáilte Ireland open data",
    radiusKm: 400,
    fetch: async (from, to) => {
      const out: EventItem[] = [];
      let url: string | undefined = "https://failteireland.azure-api.net/opendata-api/v2/events";
      for (let page = 0; url && page < 6; page++) {
        const j: { value?: Record<string, unknown>[]; "@odata.nextLink"?: string } | null = await getJson(url);
        for (const r of j?.value ?? []) {
          const name = str(r, "name");
          const date = day(str(r, "startDate"));
          if (!name || !date) continue;
          const end = day(str(r, "endDate"));
          if ((end ?? date) < from || date > to) continue;
          const loc = r.location as { name?: string; geo?: { latitude?: number; longitude?: number } } | undefined;
          out.push({ name, date: date < from ? from : date, end, venue: loc?.name, kind: str(r, "@type"), url: str(r, "url") ?? "https://www.discoverireland.ie", image: firstStr(r.image) ?? str(r, "image"), lat: loc?.geo?.latitude, lon: loc?.geo?.longitude, free: r.isAccessibleForFree === true, source: "ireland" });
        }
        url = j?.["@odata.nextLink"];
      }
      return out;
    },
  },
  {
    id: "euskadi",
    city: "Bilbao",
    lat: 43.263,
    lon: -2.935,
    licence: "CC BY 4.0",
    attribution: "Kulturklik, Open Data Euskadi",
    radiusKm: 120,
    fetch: async (from, to) => {
      const j = await getJson<{ items?: Record<string, unknown>[] }>("https://api.euskadi.eus/culture/events/v1.0/events/upcoming?_elements=100&_page=1");
      return (j?.items ?? [])
        .map((r): EventItem | null => {
          const name = str(r, "nameEs");
          const date = day(str(r, "startDate"));
          if (!name || !date || date < from || date > to) return null;
          return { name, date, end: day(str(r, "endDate")), venue: [str(r, "establishmentEs"), str(r, "municipalityEs")].filter(Boolean).join(", "), kind: str(r, "typeEs"), url: str(r, "sourceUrlEs") ?? str(r, "purchaseUrlEs") ?? "https://www.kulturklik.euskadi.eus", lat: num(r.municipalityLatitude), lon: num(r.municipalityLongitude), source: "euskadi" };
        })
        .filter((x): x is EventItem => !!x);
    },
  },
  {
    id: "taiwan",
    city: "Taipei",
    lat: 25.033,
    lon: 121.5654,
    licence: "Open Government Data License v1.0 (Taiwan)",
    attribution: "Ministry of Culture, Taiwan",
    radiusKm: 250,
    fetch: async (from, to) => {
      const out: EventItem[] = [];
      for (const cat of ["1", "6", "8"]) {
        const j = await getJson<Record<string, unknown>[]>(`https://cloud.culture.tw/frontsite/trans/SearchShowAction.do?method=doFindTypeJ&category=${cat}`);
        for (const r of j ?? []) {
          const name = str(r, "title");
          const shows = (r.showInfo as { time?: string; locationName?: string; latitude?: string; longitude?: string; price?: string }[] | undefined) ?? [];
          const first = shows.find((s) => (day(s.time) ?? "") >= from && (day(s.time) ?? "") <= to);
          if (!name || !first) continue;
          out.push({ name, date: day(first.time)!, venue: first.locationName, kind: cat === "1" ? "music" : cat === "6" ? "exhibition" : "film", url: str(r, "sourceWebPromote") ?? str(r, "webSales") ?? "https://cloud.culture.tw", image: str(r, "imageUrl"), lat: num(first.latitude), lon: num(first.longitude), free: first.price === "免費" || first.price === "", source: "taiwan" });
        }
      }
      return out;
    },
  },
];

/** Sources whose city is near a point. */
export function sourcesNear(lat: number, lon: number): Source[] {
  return SOURCES.filter((s) => haversineKm(lat, lon, s.lat, s.lon) <= (s.radiusKm ?? 45));
}
