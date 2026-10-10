// Server-only. Everything Atlas can do, as tools the chat agent calls: the boards, the
// period search, live re-pricing, combos, wild trips and their day plans, sights, events,
// rated restaurants, hotels, one-way fares, trains and coaches, facts, the live web. Each
// answer is compact (a dozen items) so the model reads it whole; the deals it returns carry
// enough to draw cards and pins on the globe.
import { jsonSchema, tool } from "ai";
import citiesJson from "@/public/data/cities.json";
import countriesJson from "@/public/data/countries.json";
import cityPlacesJson from "@/public/data/city-places.json";
import weatherJson from "@/public/data/weather.json";
import visaJson from "@/public/data/visa.json";
import airportsJson from "@/public/data/airports.json";
import fameJson from "@/public/data/fame.json";
import { nearestGateways } from "./geo";
import { reachFrom } from "./ground";
import { dealsFor } from "./deals-source";
import { findDeals } from "./finder";
import { findCombos } from "./combos";
import { kiwiDate, nightsOf, searchFlight } from "./kiwi";
import { buildWild, customKey, wildPath, REGIONS, STOPOVER_PROGRAMMES, type Budget, type Region, type Style, type Tradeoff, type WildTrip } from "./wild";
import { buildWildVariants } from "./wild-variants";
import { purposeTrips } from "./purpose";
import { fareHistory, hasDb } from "./db";
import { judgeTrip } from "./judge";
import { planDays, planPath, type Plan } from "./plan";
import { readJson, writeJson } from "./boards-store";
import { countryGuide, getSights } from "./sights";
import { isNoise, sourcesNear } from "./events/sources";
import { goodValueEats, hasFoursquare, sweetsNear } from "./foursquare";
import { hasLiteApi, hotelsNear, liteApiLive } from "./liteapi";
import { allFares, hasToken } from "./travelpayouts";
import { hasTavily, webSearch } from "./tavily";
import { mainGateway } from "./board";
import { isGem, type FameFile } from "./gems";
import { expandWeather, visaFor, type Airport, type City, type CityPlaces, type CountryInfo, type Deal, type VisaFile, type WeatherCompact } from "./types";

const CITIES = citiesJson as unknown as Record<string, City>;
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
const PLACES = cityPlacesJson as unknown as Record<string, CityPlaces>;
const WEATHER = (weatherJson as unknown as WeatherCompact).syms ? expandWeather(weatherJson as unknown as WeatherCompact) : null;
const VISA = visaJson as unknown as VisaFile;
const AIRPORTS = airportsJson as unknown as Airport[];
const FAME = fameJson as unknown as FameFile;

export type AgentContext = {
  origin?: { lat: number; lon: number; label: string };
  gateways: string[];
  home: string;
  month?: string;
  today: string;
};

function findCity(name: string): [string, City] | null {
  const q = name.trim().toLowerCase();
  if (/^[a-z]{3}$/.test(q)) {
    const code = q.toUpperCase();
    if (CITIES[code]) return [code, CITIES[code]];
    const hit = Object.entries(CITIES).find(([, c]) => c.airports.includes(code));
    if (hit) return hit;
  }
  return Object.entries(CITIES).find(([, c]) => c.name.toLowerCase() === q) ?? Object.entries(CITIES).find(([, c]) => c.name.toLowerCase().startsWith(q)) ?? Object.entries(CITIES).find(([, c]) => c.name.toLowerCase().includes(q)) ?? null;
}
function weekendMax(code: string): number | null {
  const days = WEATHER?.cities[code];
  if (!days) return null;
  const d = new Date();
  const toSat = (6 - d.getDay() + 7) % 7;
  const sat = new Date(d.getTime() + toSat * 86_400_000).toISOString().slice(0, 10);
  const sun = new Date(d.getTime() + (toSat + 1) * 86_400_000).toISOString().slice(0, 10);
  const t = days.filter((x) => x.d === sat || x.d === sun).map((x) => x.tmax);
  return t.length ? Math.max(...t) : null;
}
const compactDeal = (d: Deal) => ({
  key: `${d.gw}|${d.dst}|${d.out}`,
  city: d.city,
  country: COUNTRIES[d.country]?.name ?? d.country,
  price: d.price,
  dates: `${d.out} to ${d.back}`,
  nights: d.nights,
  from: d.gw,
  stops: d.stops,
  airline: d.carriers[0],
  flightMinutes: d.outMin,
  homeVia: d.backTo,
  trick: d.trick,
});
const countryCode = (s: string | undefined): string | undefined => {
  if (!s) return undefined;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  const hit = Object.entries(COUNTRIES).find(([, c]) => c.name.toLowerCase() === s.toLowerCase());
  return hit?.[0];
};

export function atlasTools(ctx: AgentContext) {
  const gateways = ctx.gateways.length ? ctx.gateways : ["OTP"];
  return {
    home_airports: tool({
      description: "The traveller's airports with drive time, size and whether a nightly price board exists. Use for 'which airport should I fly from'.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => {
        if (!ctx.origin) return { airports: gateways.map((g) => ({ iata: g })) };
        return nearestGateways(AIRPORTS, ctx.origin.lat, ctx.origin.lon, { maxKm: 350, limit: 6 }).map((g) => ({ iata: g.airport.iata, name: g.airport.name, city: g.airport.city, size: g.airport.size, driveMinutes: g.driveMin, km: Math.round(g.km), searchedNightly: gateways.includes(g.airport.iata) }));
      },
    }),

    cheapest_deals: tool({
      description: "Tonight's cheapest return getaways from the traveller's airports (real Kiwi.com fares, searched nightly): the next six weeks, or a month. Filters: max price, nights, direct, warm this weekend, country, city, hidden gems. Fast. Use for open questions ('where could I go cheaply', 'a warm weekend'). For a specific period of dates use find_getaways instead.",
      inputSchema: jsonSchema<{ month?: string; maxPrice?: number; minNights?: number; maxNights?: number; direct?: boolean; warm?: boolean; country?: string; city?: string; gems?: boolean; limit?: number }>({
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM; omit for the next six weeks" },
          maxPrice: { type: "number" },
          minNights: { type: "number" },
          maxNights: { type: "number" },
          direct: { type: "boolean" },
          warm: { type: "boolean", description: "20 C or more this weekend" },
          country: { type: "string", description: "country name or ISO code" },
          city: { type: "string" },
          gems: { type: "boolean", description: "hidden gems only: lots to see, few tourists" },
          limit: { type: "number", description: "default 10, max 20" },
        },
      }),
      execute: async (a) => {
        const src = await dealsFor(gateways, a.month ?? ctx.month);
        const cc = countryCode(a.country);
        const seen = new Set<string>();
        const out: Deal[] = [];
        for (const d of src.deals) {
          if (a.maxPrice != null && d.price > a.maxPrice) continue;
          if (a.minNights != null && d.nights < a.minNights) continue;
          if (a.maxNights != null && d.nights > a.maxNights) continue;
          if (a.direct && d.stops > 0) continue;
          if (cc && d.country !== cc) continue;
          if (a.city && !d.city.toLowerCase().includes(a.city.toLowerCase())) continue;
          if (a.warm && (weekendMax(d.dstCity) ?? -99) < 20) continue;
          if (a.gems && !isGem(FAME, d.dstCity, 0, PLACES[d.dstCity])) continue;
          if (seen.has(d.dstCity)) continue;
          seen.add(d.dstCity);
          out.push(d);
          if (out.length >= Math.min(20, a.limit ?? 10)) break;
        }
        return { searchedOn: src.updated.slice(0, 10), airports: src.gateways, count: out.length, deals: out.map((d) => ({ ...compactDeal(d), weekendHighC: weekendMax(d.dstCity) })), raw: out };
      },
    }),

    find_getaways: tool({
      description: "A live search for a trip inside a period: 'between 20 and 30 October, 3 to 6 nights, away on the 26th, from any of my airports, anywhere or a country, direct, home may land at another of my airports'. About 20 live Kiwi searches, half a minute. Use whenever the traveller gives dates or a period.",
      inputSchema: jsonSchema<{ from: string; to: string; include?: string; minNights?: number; maxNights?: number; direct?: boolean; maxHours?: number; where?: string; origins?: string[]; returnTo?: string[]; tricks?: boolean }>({
        type: "object",
        properties: {
          from: { type: "string", description: "YYYY-MM-DD, start of the period" },
          to: { type: "string", description: "YYYY-MM-DD, end of the period (be home by)" },
          include: { type: "string", description: "YYYY-MM-DD the traveller must be away on, optional" },
          minNights: { type: "number", description: "default 2" },
          maxNights: { type: "number", description: "default 7" },
          direct: { type: "boolean" },
          maxHours: { type: "number", description: "max hours per flight leg" },
          where: { type: "string", description: "'anywhere' (default), a region (Europe, Asia) or a country name" },
          origins: { type: "array", items: { type: "string" }, description: "IATA codes; default the traveller's airports" },
          returnTo: { type: "array", items: { type: "string" }, description: "other home airports the flight back may land at (open-jaw)" },
          tricks: { type: "boolean", description: "also scan hidden-city one-ways (risky; only when asked)" },
        },
        required: ["from", "to"],
      }),
      execute: async (a) => {
        const r = await findDeals({ origins: a.origins?.length ? a.origins : gateways, from: a.from, to: a.to, include: a.include, minNights: a.minNights ?? 2, maxNights: a.maxNights ?? 7, direct: a.direct, maxHours: a.maxHours, where: a.where ?? "anywhere", returnTo: a.returnTo, tricks: a.tricks });
        const seen = new Set<string>();
        const top = r.deals.filter((d) => !seen.has(d.dstCity + (d.backTo ?? "")) && seen.add(d.dstCity + (d.backTo ?? ""))).slice(0, 14);
        return { searched: r.searched, found: r.deals.length, openJaw: r.openJaw, deals: top.map(compactDeal), raw: top };
      },
    }),

    reprice_route: tool({
      description: "Live Kiwi.com prices for one route around a date: 'what does Bucharest to Venice cost on 7 November for 3 nights'. Returns the cheapest itineraries with booking links.",
      inputSchema: jsonSchema<{ from: string; to: string; depart: string; nights?: number; flexDays?: number }>({
        type: "object",
        properties: { from: { type: "string", description: "IATA or city code" }, to: { type: "string" }, depart: { type: "string", description: "YYYY-MM-DD" }, nights: { type: "number", description: "omit for one-way" }, flexDays: { type: "number", description: "default 2" } },
        required: ["from", "to", "depart"],
      }),
      execute: async (a) => {
        const flex = a.flexDays ?? 2;
        const back = a.nights ? new Date(Date.parse(a.depart) + a.nights * 86_400_000).toISOString().slice(0, 10) : null;
        const r = await searchFlight({ flyFrom: a.from.toUpperCase(), flyTo: a.to, departureDate: kiwiDate(a.depart), departureDateFlexDays: flex, ...(back ? { returnDate: kiwiDate(back), returnDateFlexDays: flex } : {}) });
        return r.itineraries
          .sort((x, y) => x.price - y.price)
          .slice(0, 6)
          .map((it) => ({ price: Math.round(it.price), out: it.outbound.departureTime.slice(0, 16), back: it.inbound?.departureTime.slice(0, 16), nights: nightsOf(it), stops: Math.max(it.outbound.stops, it.inbound?.stops ?? 0), carriers: [...new Set([...it.outbound.segments, ...(it.inbound?.segments ?? [])].map((s) => s.carrierName))], hours: Math.round(it.outbound.durationSeconds / 360) / 10, url: it.bookingUrl }));
      },
    }),

    two_city_combos: tool({
      description: "For a return deal: fly in to the city, hop by train or coach to a neighbour, fly home from there, priced live. Often cheaper and you see two places. Needs the deal's home airport, destination airport, city code, dates and price (from a deals result).",
      inputSchema: jsonSchema<{ from: string; dst: string; city: string; out: string; back: string; price: number }>({
        type: "object",
        properties: { from: { type: "string" }, dst: { type: "string" }, city: { type: "string", description: "destination city code" }, out: { type: "string" }, back: { type: "string" }, price: { type: "number" } },
        required: ["from", "dst", "city", "out", "back", "price"],
      }),
      execute: async (a) => {
        const r = await findCombos(a.from.toUpperCase(), a.dst.toUpperCase(), a.city.toUpperCase(), a.out, a.back, a.price);
        return { base: r.base, outOneWay: r.outPrice, combos: r.combos.slice(0, 4).map((c) => ({ next: c.name, country: c.country, ground: `${c.groundMode} ${Math.round(c.groundMin / 60 * 10) / 10} h${c.estimated ? " (estimate)" : ""}`, homeFromThere: c.inPrice, total: c.total, saves: c.saves, outUrl: r.outUrl, homeUrl: c.inUrl })) };
      },
    }),

    wild_trip: tool({
      description: "A long multi-country loop (7 to 28 nights) into a far region: fly out (via a cheaper hub when that wins), chain cheap one-way flights and border hops for two or three nights a stop, fly home (any of the traveller's airports, plus the last leg to their door), with living costs per stop, visas, a stopover night in a hub when it costs about the same, and a model's verdict. Regions: " + Object.entries(REGIONS).map(([k, v]) => `${k} (${v.label})`).join(", ") + ". Style: experiences, beaches, food, cities, slow. Budget: backpacker, mid, comfort. Tradeoff: price (cheapest whatever the hours), balanced, comfort (pays more for short flights and few stops). variants=3 builds the balanced, cheapest and comfortable versions and ranks them (use when the traveller wants options or asks why everything goes through one hub). noHubs skips the positioning hub (Istanbul, Budapest). Optional custom country list, countries to favour, max stops, nights per stop. Takes one to two minutes unless already built; say so before calling.",
      inputSchema: jsonSchema<{ region: Region; nights?: number; style?: Style; budget?: Budget; month?: string; countries?: string[]; prefer?: string[]; maxStops?: number; nightsPerStop?: number; stopover?: boolean; tradeoff?: Tradeoff; noHubs?: boolean; variants?: number }>({
        type: "object",
        properties: {
          region: { type: "string", enum: Object.keys(REGIONS) },
          nights: { type: "number", description: "7 to 28, default 14" },
          style: { type: "string", enum: ["experiences", "beaches", "food", "cities", "slow"] },
          budget: { type: "string", enum: ["backpacker", "mid", "comfort"] },
          month: { type: "string", description: "YYYY-MM" },
          countries: { type: "array", items: { type: "string" }, description: "ISO2 codes to restrict to, e.g. ['VN','TH']" },
          prefer: { type: "array", items: { type: "string" }, description: "ISO2 codes to favour" },
          maxStops: { type: "number" },
          nightsPerStop: { type: "number" },
          stopover: { type: "boolean", description: "allow a hub night on the way home, default true" },
          tradeoff: { type: "string", enum: ["price", "balanced", "comfort"] },
          noHubs: { type: "boolean", description: "fly only from the traveller's own airports" },
          variants: { type: "number", description: "1 (default) or 2 to 4 ranked variants" },
        },
        required: ["region"],
      }),
      execute: async (a) => {
        const nights = Math.min(28, Math.max(7, a.nights ?? 14));
        const style = a.style ?? "experiences";
        const budget = a.budget ?? "mid";
        const month = a.month ?? ctx.month;
        const summarise = (trip: WildTrip) => ({
          title: trip.title,
          dates: `${trip.outDate} to ${trip.backDate}`,
          totals: trip.totals,
          legs: trip.legs.map((l) => (l.kind === "fly" ? `${l.date} fly ${l.fromName} → ${l.toName} €${l.price}, ${l.hours} h, ${l.stops ? `${l.stops} stop` : "direct"}` : `${l.date} ${l.mode} ${l.fromName} → ${l.toName} ~${Math.round(l.minutes / 60)} h`)),
          stops: trip.stops.map((s) => `${s.name} (${s.country}) ${s.nights} nights, about €${s.perDay}/day${s.visa ? `, ${s.visa}` : ""}${s.note ? `; ${s.note}` : ""}`),
          judge: trip.judge,
        });
        if ((a.variants ?? 1) > 1) {
          const ranked = await buildWildVariants({ gateways, home: ctx.home, region: a.region, month, nights, style, budget, origin: ctx.origin, stopover: a.stopover, countries: a.countries, prefer: a.prefer, maxStops: a.maxStops, nightsPerStop: a.nightsPerStop }, Math.min(4, a.variants ?? 3));
          if (!ranked.length) return { error: "no way into that region on those dates from here; try another month or region" };
          return { ranked: ranked.map((t) => ({ rank: t.rank, variant: t.variant, score: t.score, ...summarise(t) })), key: { region: a.region, nights, style, budget, month }, raw: ranked[0] };
        }
        const custom = customKey(a.countries, a.prefer, a.maxStops, a.nightsPerStop, a.tradeoff, a.noHubs);
        const path = wildPath(mainGateway(gateways), a.region, month, nights, style, budget, custom);
        const stored = await readJson<WildTrip>(path);
        let trip = stored && stored.ageHours < 24 ? stored.body : null;
        if (!trip) {
          const built = await buildWild({ gateways, home: ctx.home, region: a.region, month, nights, style, budget, origin: ctx.origin, stopover: a.stopover, countries: a.countries, prefer: a.prefer, maxStops: a.maxStops, nightsPerStop: a.nightsPerStop, tradeoff: a.tradeoff, noHubs: a.noHubs });
          if (!built) return { error: "no way into that region on those dates from here; try another month or region" };
          const judge = await judgeTrip(built);
          trip = { ...built, judge: judge ?? undefined };
          await writeJson(path, trip).catch(() => null);
        }
        return { ...summarise(trip), key: { region: a.region, nights, style, budget, month, custom }, raw: trip };
      },
    }),

    events_worth_travelling_for: tool({
      description: "Travel with a purpose: the events worth flying for inside a window (carnivals, festivals, marathons, fire festivals, lantern nights, seasons like cherry blossom or northern lights), each with the cheapest way there from the traveller's airports (tonight's boards, then a live search for the nearest few). Use for 'something special to go to in November', 'Halloween somewhere cool', 'a marathon abroad'.",
      inputSchema: jsonSchema<{ from: string; to: string; kinds?: string[]; live?: number }>({
        type: "object",
        properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" }, kinds: { type: "array", items: { type: "string", enum: ["festival", "sport", "culture", "season", "music", "food"] } }, live: { type: "number", description: "how many unpriced events to price live (default 4, slow)" } },
        required: ["from", "to"],
      }),
      execute: async (a) => {
        const r = await purposeTrips(gateways, a.from, a.to, { live: a.live, kinds: a.kinds as never });
        return { events: r.slice(0, 12).map((t) => ({ event: t.event.name, city: t.event.city, country: t.event.country, dates: `${t.event.start} to ${t.event.end}`, kind: t.event.kind, note: t.event.note, cheapestTrip: t.deal ? compactDeal(t.deal) : null, priced: t.source })), raw: r.map((t) => t.deal).filter((d): d is Deal => !!d) };
      },
    }),

    stopover_programmes: tool({
      description: "Airlines that give a free or very cheap hotel night in their hub on the way (Turkish Airlines in Istanbul, Qatar in Doha, TAP in Lisbon, Icelandair, Finnair, Emirates, Singapore). Use when a route goes through one of these hubs or the traveller asks about layover hacks.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => Object.entries(STOPOVER_PROGRAMMES).map(([hub, p]) => ({ hub, airline: p.airline, note: p.note })),
    }),

    ...(hasDb()
      ? {
          fare_history: tool({
            description: "What a route cost whenever anyone on Atlas looked, cheapest per departure date with the time it was seen: tells whether a fare is good now and how it moved. Airport codes.",
            inputSchema: jsonSchema<{ from: string; to: string; dateFrom?: string; dateTo?: string }>({ type: "object", properties: { from: { type: "string" }, to: { type: "string" }, dateFrom: { type: "string" }, dateTo: { type: "string" } }, required: ["from", "to"] }),
            execute: async (a) => fareHistory(a.from.toUpperCase(), a.to.toUpperCase(), a.dateFrom, a.dateTo, 25),
          }),
        }
      : {}),

    plan_days: tool({
      description: "The day-by-day plan of a wild trip already built in this conversation: experiences, food and where, costs per day, a month's rent per city. Grounded in guides, live web research and rated restaurants. About a minute. Pass the same region, nights, style, budget, month as the trip.",
      inputSchema: jsonSchema<{ region: Region; nights?: number; style?: Style; budget?: Budget; month?: string; custom?: string }>({
        type: "object",
        properties: { region: { type: "string", enum: Object.keys(REGIONS) }, nights: { type: "number" }, style: { type: "string" }, budget: { type: "string" }, month: { type: "string" }, custom: { type: "string" } },
        required: ["region"],
      }),
      execute: async (a) => {
        const nights = Math.min(28, Math.max(7, a.nights ?? 14));
        const tripPath = wildPath(mainGateway(gateways), a.region, a.month ?? ctx.month, nights, a.style ?? "experiences", a.budget ?? "mid", a.custom ?? "");
        const path = planPath(tripPath);
        const stored = await readJson<Plan>(path);
        if (stored && stored.ageHours < 72) return { highlights: stored.body.highlights, days: stored.body.days, food: stored.body.food, monthly: stored.body.monthly, total: stored.body.total };
        const trip = await readJson<WildTrip>(tripPath);
        if (!trip) return { error: "build the trip first with wild_trip" };
        const plan = await planDays(trip.body, path);
        if (!plan) return { error: "the planner did not answer; try again" };
        await writeJson(path, plan).catch(() => null);
        return { highlights: plan.highlights, days: plan.days, food: plan.food, monthly: plan.monthly, total: plan.total };
      },
    }),

    sights: tool({
      description: "What to see and do in a city from the Wikivoyage guide (names, a line each, photos exist), its festivals, and what the country is known for doing and eating.",
      inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
      execute: async ({ city }) => {
        const hit = findCity(city);
        const name = hit ? hit[1].name : city;
        const [s, g] = await Promise.all([getSights(name), hit ? countryGuide(COUNTRIES[hit[1].country]?.name ?? hit[1].country) : null]);
        return { city: name, see: s?.see.slice(0, 8).map((x) => `${x.name}${x.desc ? `: ${x.desc.slice(0, 110)}` : ""}`), do: s?.do.slice(0, 6).map((x) => `${x.name}${x.desc ? `: ${x.desc.slice(0, 110)}` : ""}`), eat: s?.eat.slice(0, 5).map((x) => `${x.name}${x.desc ? `: ${x.desc.slice(0, 90)}` : ""}`), festivals: s?.events.slice(0, 5), countryDo: g?.do.slice(0, 5), countryEat: g?.eat.slice(0, 4), guideUrl: s?.url };
      },
    }),

    events_near: tool({
      description: "What's on in a city in the next weeks from the city's own open event feed (20 cities have one: Paris, Madrid, Lisbon, Bologna, Berlin, Helsinki, New York, Chicago, San Francisco, Brisbane, Taipei and more). Says so when a city has none.",
      inputSchema: jsonSchema<{ city: string; days?: number }>({ type: "object", properties: { city: { type: "string" }, days: { type: "number", description: "default 30" } }, required: ["city"] }),
      execute: async ({ city, days }) => {
        const hit = findCity(city);
        if (!hit) return { error: `no city named ${city}` };
        const [, c] = hit;
        const near = sourcesNear(c.lat, c.lon);
        if (!near.length) return { city: c.name, events: [], note: "no open event feed for this city; use web_search for what's on" };
        const from = ctx.today;
        const to = new Date(Date.parse(from) + (days ?? 30) * 86_400_000).toISOString().slice(0, 10);
        const lists = await Promise.all(near.map((s) => s.fetch(from, to).catch(() => [])));
        const ev = lists.flat().filter((e) => !isNoise(e.name, e.kind)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 12);
        return { city: c.name, sources: near.map((s) => s.attribution), events: ev.map((e) => ({ date: e.date, name: e.name, venue: e.venue, kind: e.kind, url: e.url })) };
      },
    }),

    ...(hasFoursquare()
      ? {
          eats_near: tool({
            description: "Rated restaurants near a city centre that are good value (Foursquare rating 8+/10, price tier 1 or 2) with a tip each, or the best sweet places. Use for 'where should I eat in X', 'best ice cream in X'.",
            inputSchema: jsonSchema<{ city: string; sweet?: boolean }>({ type: "object", properties: { city: { type: "string" }, sweet: { type: "boolean" } }, required: ["city"] }),
            execute: async ({ city, sweet }) => {
              const hit = findCity(city);
              if (!hit) return { error: `no city named ${city}` };
              const [, c] = hit;
              const r = sweet ? await sweetsNear(c.lat, c.lon) : await goodValueEats(c.lat, c.lon);
              if (r.status !== "ok") return { error: r.note ?? r.status };
              return r.places.map((p) => ({ name: p.name, rating: p.rating, price: "€".repeat(p.price ?? 1), category: p.category, address: p.address, tip: p.tip }));
            },
          }),
        }
      : {}),

    ...(hasLiteApi()
      ? {
          hotels_near: tool({
            description: `The cheapest decent hotels near a city centre for given nights (LiteAPI, live prices${liteApiLive() ? "" : "; sandbox key: test prices, say so"}).`,
            inputSchema: jsonSchema<{ city: string; checkin: string; checkout: string }>({ type: "object", properties: { city: { type: "string" }, checkin: { type: "string" }, checkout: { type: "string" } }, required: ["city", "checkin", "checkout"] }),
            execute: async ({ city, checkin, checkout }) => {
              const hit = findCity(city);
              if (!hit) return { error: `no city named ${city}` };
              const [, c] = hit;
              const r = await hotelsNear(c.lat, c.lon, checkin, checkout, ctx.home);
              return { status: r.status, note: r.note, hotels: r.hotels.map((h) => ({ name: h.name, stars: h.stars, guests: h.rating, perNight: h.perNight, total: h.total })) };
            },
          }),
        }
      : {}),

    ...(hasToken()
      ? {
          oneway_fares: tool({
            description: "Cheapest cached one-way fares out of an airport over the coming months (what people recently paid, Travelpayouts), by destination. Good for building your own multi-city routes.",
            inputSchema: jsonSchema<{ origin: string; limit?: number }>({ type: "object", properties: { origin: { type: "string", description: "IATA" }, limit: { type: "number" } }, required: ["origin"] }),
            execute: async ({ origin, limit }) => (await allFares({ origin: origin.toUpperCase() })).sort((a, b) => a.price - b.price).slice(0, Math.min(30, limit ?? 15)).map((f) => ({ to: f.dst, city: CITIES[Object.entries(CITIES).find(([, c]) => c.airports.includes(f.dst))?.[0] ?? ""]?.name, price: f.price, date: f.departureAt.slice(0, 10), stops: f.transfers, url: f.url })),
          }),
        }
      : {}),

    ground_reach: tool({
      description: "Towns reachable by train, coach or ferry from where the traveller is, within a time limit (expected door-to-door minutes from timetables, Europe only), biggest first.",
      inputSchema: jsonSchema<{ maxHours?: number; limit?: number }>({ type: "object", properties: { maxHours: { type: "number", description: "default 5, max 10" }, limit: { type: "number" } } }),
      execute: async (a) => {
        if (!ctx.origin) return { error: "the traveller's location is unknown" };
        const max = Math.min(600, Math.max(60, Math.round((a.maxHours ?? 5) * 60)));
        const r = reachFrom(ctx.origin.lat, ctx.origin.lon, max);
        const seen = new Set<string>();
        return r.reached
          .filter((s) => s.pop >= 15_000)
          .sort((x, y) => y.pop - x.pop)
          .filter((s) => !seen.has(s.town ?? s.name) && seen.add(s.town ?? s.name))
          .slice(0, Math.min(25, a.limit ?? 12))
          .map((s) => ({ town: s.town ?? s.name, population: s.pop, minutes: s.minutes, changes: s.changes, mode: s.mode }));
      },
    }),

    place_facts: tool({
      description: "Facts about a city and its country: population, how known it is, counts of restaurants, bars, nightlife, culture, nature, currency and rate, plugs, languages, visa for the traveller's passport, travel warning, this weekend's high.",
      inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
      execute: async ({ city }) => {
        const hit = findCity(city);
        if (!hit) return { error: `no city named ${city}` };
        const [code, c] = hit;
        const co = COUNTRIES[c.country];
        return { city: c.name, country: co?.name ?? c.country, population: c.pop, wikipediaViewsPerYear: FAME[code]?.[0], places: PLACES[code], currency: co?.currency, eurRate: co?.rate, plugs: co?.plugs, voltage: co?.voltage, languages: co?.languages, visaForHomePassport: c.country !== ctx.home ? visaFor(VISA, ctx.home, c.country) : "home country", travelWarning: co?.advisory?.warning ? "full" : co?.advisory?.partial ? "partial" : "none", weekendHighC: weekendMax(code), hiddenGem: isGem(FAME, code, 0, PLACES[code]) };
      },
    }),

    ...(hasTavily()
      ? {
          web_search: tool({
            description: "Search the live web for current recommendations and facts: best traditional food and where locals eat, what's on this month, how to do a loop or a cruise, entry rules, prices. Returns page snippets with their sources; cite the site.",
            inputSchema: jsonSchema<{ query: string }>({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
            execute: async ({ query }) => (await webSearch(query, 5)).map((h) => ({ title: h.title, source: h.url, snippet: h.content.slice(0, 600) })),
          }),
        }
      : {}),
  };
}
