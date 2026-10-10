// Events worth flying for: the ones people plan a year around. Curated by hand, 2026 edition;
// the model and the web fill in the rest when asked for something not here.
//
// Dates. A fixed-date event (Songkran, King's Day, Inti Raymi) has its usual month and days,
// projected onto any year. An event that moves with the moon, Easter or a weekday (Holi,
// Diwali, Tet, the carnivals, the marathons) has `dates` per year instead, and is only dated
// in a year listed there: projecting 2026's Holi onto 2027 would put a trip three weeks early,
// so an unknown edition is left out rather than guessed. Festival editions still shift by a
// day or two; the sources line of an itinerary says "check the edition".
//
// Places. `code` and `city` are where you fly to (the place on the globe and the fare);
// `lat`, `lon` and `venue` are where it actually happens when that is somewhere else (Up Helly
// Aa is in Lerwick, not Edinburgh), so a search by point and an itinerary only find an event
// where it is.
//
// Client-safe on purpose (no imports at all): the place pages, the command line and the deal
// badges in the browser ask "what is on here, then" without a request. That is why every
// event carries its own coordinates (the city on the globe, copied from cities.json) instead
// of looking them up.
export type PurposeEvent = {
  name: string;
  /** The city you fly to, in words. */
  city: string;
  /** The city code you fly to. */
  code: string;
  country: string;
  /** Where it happens, when that is not `city` (a town near it, an island further on). */
  venue?: string;
  /** Where it happens: the venue when there is one, else the city. */
  lat: number;
  lon: number;
  month: number;
  day?: number;
  endDay?: number;
  /** Per year, "MM-DD" first and last day, for events that move; other years are unknown. */
  dates?: Partial<Record<number, [string, string?]>>;
  kind: "festival" | "sport" | "culture" | "season" | "music" | "food"; note: string; url?: string };

export const PURPOSE_EVENTS: PurposeEvent[] = [
  { name: "Carnival of Venice", city: "Venice", code: "VCE", country: "IT", lat: 45.4408, lon: 12.3155, month: 2, day: 7, endDay: 17, dates: { 2026: ["02-07", "02-17"], 2027: ["01-30", "02-09"] }, kind: "festival", note: "masks on the lagoon; peaks the final weekend" },
  { name: "Rio Carnival", city: "Rio de Janeiro", code: "RIO", country: "BR", lat: -22.9068, lon: -43.1729, month: 2, day: 13, endDay: 18, dates: { 2026: ["02-13", "02-18"], 2027: ["02-05", "02-10"] }, kind: "festival", note: "the Sambadrome parades" },
  { name: "Holi", city: "Jaipur", code: "JAI", country: "IN", lat: 26.9124, lon: 75.7873, month: 3, day: 3, endDay: 4, dates: { 2026: ["03-03", "03-04"], 2027: ["03-21", "03-22"] }, kind: "festival", note: "the colour festival; Mathura and Vrindavan nearby" },
  { name: "Las Fallas", city: "Valencia", code: "VLC", country: "ES", lat: 39.4699, lon: -0.3763, month: 3, day: 15, endDay: 19, kind: "festival", note: "giant sculptures burned on the 19th" },
  { name: "Cherry blossom", city: "Tokyo", code: "TYO", country: "JP", lat: 35.6762, lon: 139.6503, month: 3, day: 25, endDay: 10, kind: "season", note: "late March to early April; Kyoto a week later" },
  { name: "Songkran", city: "Chiang Mai", code: "CNX", country: "TH", lat: 18.7953, lon: 98.962, month: 4, day: 13, endDay: 15, kind: "festival", note: "the water festival" },
  { name: "King's Day", city: "Amsterdam", code: "AMS", country: "NL", lat: 52.3731, lon: 4.8922, month: 4, day: 27, kind: "festival", note: "orange, canals, street markets" },
  { name: "Primavera Sound", city: "Barcelona", code: "BCN", country: "ES", lat: 41.3879, lon: 2.1699, month: 6, day: 4, endDay: 6, kind: "music", note: "" },
  { name: "Midsummer", city: "Stockholm", code: "STO", country: "SE", lat: 59.3328, lon: 18.0645, month: 6, day: 19, endDay: 20, kind: "festival", note: "the archipelago, flower crowns" },
  { name: "Glastonbury", city: "Bristol", code: "BRS", country: "GB", venue: "Pilton, Somerset", lat: 51.1537, lon: -2.5856, month: 6, day: 24, endDay: 28, dates: { 2027: ["06-23", "06-27"] }, kind: "music", note: "2026 is a fallow year; tickets sell out a year ahead" },
  { name: "Roskilde", city: "Copenhagen", code: "CPH", country: "DK", lat: 55.6761, lon: 12.5683, month: 6, day: 27, endDay: 4, kind: "music", note: "" },
  { name: "Running of the Bulls", city: "Pamplona", code: "PNA", country: "ES", lat: 42.818, lon: -1.6442, month: 7, day: 6, endDay: 14, kind: "festival", note: "San Fermín" },
  { name: "Gion Matsuri", city: "Osaka", code: "OSA", country: "JP", venue: "Kyoto", lat: 35.0037, lon: 135.7788, month: 7, day: 17, kind: "festival", note: "Kyoto's float procession" },
  { name: "Tomorrowland", city: "Brussels", code: "BRU", country: "BE", venue: "Boom", lat: 51.0917, lon: 4.3717, month: 7, day: 17, endDay: 26, kind: "music", note: "Boom, near Antwerp" },
  { name: "Sziget", city: "Budapest", code: "BUD", country: "HU", lat: 47.4984, lon: 19.0408, month: 8, day: 5, endDay: 10, kind: "music", note: "the island festival" },
  { name: "Edinburgh Fringe", city: "Edinburgh", code: "EDI", country: "GB", lat: 55.9502, lon: -3.1875, month: 8, day: 1, endDay: 25, kind: "culture", note: "the world's biggest arts festival; book rooms early" },
  { name: "La Tomatina", city: "Valencia", code: "VLC", country: "ES", venue: "Buñol", lat: 39.4197, lon: -0.7903, month: 8, day: 26, dates: { 2026: ["08-26"], 2027: ["08-25"] }, kind: "festival", note: "Buñol, 40 km away" },
  { name: "Notting Hill Carnival", city: "London", code: "LON", country: "GB", lat: 51.5074, lon: -0.1278, month: 8, day: 30, endDay: 31, kind: "festival", note: "" },
  { name: "Oktoberfest", city: "Munich", code: "MUC", country: "DE", lat: 48.1391, lon: 11.5802, month: 9, day: 19, endDay: 4, dates: { 2026: ["09-19", "10-04"], 2027: ["09-18", "10-03"] }, kind: "festival", note: "mid September to early October" },
  { name: "Berlin Marathon", city: "Berlin", code: "BER", country: "DE", lat: 52.5234, lon: 13.4114, month: 9, day: 27, dates: { 2026: ["09-27"], 2027: ["09-26"] }, kind: "sport", note: "the flat, fast one; ballot" },
  { name: "Mid-Autumn lanterns", city: "Hong Kong", code: "HKG", country: "HK", lat: 22.3193, lon: 114.1694, month: 9, day: 25, dates: { 2026: ["09-25"], 2027: ["09-15"] }, kind: "festival", note: "Victoria Park lanterns, fire dragon dance" },
  { name: "Albuquerque Balloon Fiesta", city: "Albuquerque", code: "ABQ", country: "US", lat: 35.0844, lon: -106.6504, month: 10, day: 3, endDay: 11, kind: "festival", note: "hundreds of balloons at dawn" },
  { name: "Chicago Marathon", city: "Chicago", code: "CHI", country: "US", lat: 41.8781, lon: -87.6298, month: 10, day: 11, dates: { 2026: ["10-11"], 2027: ["10-10"] }, kind: "sport", note: "" },
  { name: "Diwali", city: "New Delhi", code: "DEL", country: "IN", lat: 28.6139, lon: 77.209, month: 11, day: 8, dates: { 2026: ["11-08"], 2027: ["10-29"] }, kind: "festival", note: "lamps and fireworks; Jaipur and Varanasi too" },
  { name: "Day of the Dead", city: "Mexico City", code: "MEX", country: "MX", lat: 19.427, lon: -99.1276, month: 11, day: 1, endDay: 2, kind: "festival", note: "the parade and the Oaxaca cemeteries" },
  { name: "Samhuinn Fire Festival", city: "Edinburgh", code: "EDI", country: "GB", lat: 55.9502, lon: -3.1875, month: 10, day: 31, kind: "festival", note: "Halloween on Calton Hill; Scotland's own" },
  { name: "Loy Krathong and Yi Peng", city: "Chiang Mai", code: "CNX", country: "TH", lat: 18.7953, lon: 98.962, month: 11, day: 24, endDay: 25, dates: { 2026: ["11-24", "11-25"] }, kind: "festival", note: "thousands of lanterns released" },
  { name: "New York Marathon", city: "New York", code: "NYC", country: "US", lat: 40.7144, lon: -74.006, month: 11, day: 1, dates: { 2026: ["11-01"], 2027: ["11-07"] }, kind: "sport", note: "" },
  { name: "Christmas markets", city: "Vienna", code: "VIE", country: "AT", lat: 48.2082, lon: 16.3738, month: 12, day: 1, endDay: 23, kind: "season", note: "Vienna, Prague, Nuremberg, Strasbourg" },
  { name: "Northern lights season", city: "Tromso", code: "TOS", country: "NO", lat: 69.6798, lon: 18.9073, month: 12, day: 1, endDay: 28, kind: "season", note: "December to March, Tromsø and Lofoten" },
  { name: "Harbin Ice Festival", city: "Harbin", code: "HRB", country: "CN", lat: 45.8038, lon: 126.535, month: 1, day: 5, endDay: 28, kind: "festival", note: "ice palaces at minus 25" },
  { name: "Up Helly Aa", city: "Edinburgh", code: "EDI", country: "GB", venue: "Lerwick, Shetland", lat: 60.1546, lon: -1.1494, month: 1, day: 27, dates: { 2026: ["01-27"], 2027: ["01-26"] }, kind: "festival", note: "Shetland's Viking fire festival; fly on to Sumburgh" },
  { name: "Tet", city: "Ho Chi Minh City", code: "SGN", country: "VN", lat: 10.8231, lon: 106.6297, month: 2, day: 17, dates: { 2026: ["02-17"], 2027: ["02-06"] }, kind: "festival", note: "Vietnamese new year; many shops close" },
  { name: "Sakura in Kyoto", city: "Osaka", code: "OSA", country: "JP", venue: "Kyoto", lat: 35.0116, lon: 135.7681, month: 4, day: 1, endDay: 10, kind: "season", note: "Philosopher's Path, Arashiyama" },
  { name: "Monaco Grand Prix", city: "Nice", code: "NCE", country: "FR", venue: "Monaco", lat: 43.7347, lon: 7.4206, month: 6, day: 5, endDay: 7, dates: { 2026: ["06-05", "06-07"] }, kind: "sport", note: "the 2027 date is not set yet" },
  { name: "Cannes Film Festival", city: "Nice", code: "NCE", country: "FR", venue: "Cannes", lat: 43.5513, lon: 7.0128, month: 5, day: 12, endDay: 23, kind: "culture", note: "" },
  { name: "Inti Raymi", city: "Cusco", code: "CUZ", country: "PE", lat: -13.5384, lon: -71.9437, month: 6, day: 24, kind: "festival", note: "the Inca sun festival at Sacsayhuamán" },
  { name: "Lantern Festival", city: "Taipei", code: "TPE", country: "TW", lat: 25.033, lon: 121.5654, month: 3, day: 3, dates: { 2026: ["03-03"], 2027: ["02-20"] }, kind: "festival", note: "Pingxi sky lanterns" },
  { name: "Burning Man", city: "Reno", code: "RNO", country: "US", venue: "Black Rock City, Nevada", lat: 40.7864, lon: -119.2065, month: 8, day: 30, endDay: 7, dates: { 2026: ["08-30", "09-07"], 2027: ["08-29", "09-06"] }, kind: "festival", note: "Black Rock Desert; tickets by lottery" },
  { name: "Exit Festival", city: "Belgrade", code: "BEG", country: "RS", venue: "Novi Sad", lat: 45.2517, lon: 19.8619, month: 7, day: 9, endDay: 12, kind: "music", note: "Novi Sad fortress" },
  { name: "Untold", city: "Cluj-Napoca", code: "CLJ", country: "RO", lat: 46.7712, lon: 23.6236, month: 8, day: 6, endDay: 9, kind: "music", note: "" },
  { name: "Vivid Sydney", city: "Sydney", code: "SYD", country: "AU", lat: -33.8689, lon: 151.2071, month: 5, day: 22, endDay: 13, kind: "culture", note: "light festival, late May to mid June" },
  { name: "Mardi Gras", city: "New Orleans", code: "MSY", country: "US", lat: 29.9511, lon: -90.0715, month: 2, day: 17, dates: { 2026: ["02-17"], 2027: ["02-09"] }, kind: "festival", note: "the weeks before Fat Tuesday" },
  { name: "Marrakech Popular Arts Festival", city: "Marrakech", code: "RAK", country: "MA", lat: 31.6295, lon: -7.9811, month: 7, day: 1, endDay: 5, kind: "culture", note: "verify dates" },
  { name: "Cape Town Jazz Festival", city: "Cape Town", code: "CPT", country: "ZA", lat: -33.9249, lon: 18.4241, month: 3, day: 27, endDay: 28, kind: "music", note: "" },
  { name: "Naadam", city: "Ulaanbaatar", code: "ULN", country: "MN", lat: 47.8864, lon: 106.9057, month: 7, day: 11, endDay: 13, kind: "festival", note: "wrestling, horse racing, archery on the steppe" },
  { name: "Gerewol", city: "Niamey", code: "NIM", country: "NE", venue: "Ingall, Niger", lat: 16.7833, lon: 6.9333, month: 9, day: 20, kind: "festival", note: "Wodaabe courtship festival; check security" },
  { name: "Wimbledon", city: "London", code: "LON", country: "GB", lat: 51.5074, lon: -0.1278, month: 6, day: 29, endDay: 12, kind: "sport", note: "the queue for day tickets" },
  { name: "Tour de France finale", city: "Paris", code: "PAR", country: "FR", lat: 48.8566, lon: 2.3522, month: 7, day: 26, kind: "sport", note: "Champs-Élysées" },
  { name: "Fête des Lumières", city: "Lyon", code: "LYS", country: "FR", lat: 45.764, lon: 4.8357, month: 12, day: 5, endDay: 8, kind: "culture", note: "the city lit up" },
];

/** Events falling in a window, with their likely dates for that year (a span that crosses a month end runs into the next month). */
export function eventsInWindow(from: string, to: string): (PurposeEvent & { start: string; end: string })[] {
  const out: (PurposeEvent & { start: string; end: string })[] = [];
  const y0 = Number(from.slice(0, 4));
  for (const e of PURPOSE_EVENTS) {
    for (const y of [y0, y0 + 1]) {
      if (e.dates) {
        // A moving event: only the editions we know. An end before the start runs into the next year.
        const d = e.dates[y];
        if (!d) continue;
        const s = `${y}-${d[0]}`;
        const en = d[1] ? `${d[1] < d[0] ? y + 1 : y}-${d[1]}` : s;
        if (en >= from && s <= to) out.push({ ...e, start: s, end: en });
        continue;
      }
      const start = new Date(Date.UTC(y, e.month - 1, e.day ?? 1));
      let end = new Date(Date.UTC(y, e.month - 1, e.endDay ?? e.day ?? 28));
      if (end < start) end = new Date(Date.UTC(y, e.month, e.endDay ?? 1));
      const s = start.toISOString().slice(0, 10);
      const en = end.toISOString().slice(0, 10);
      if (en >= from && s <= to) out.push({ ...e, start: s, end: en });
    }
  }
  return out;
}

/**
 * One curated event at a place, dated for the window asked: `city` is the code you fly to,
 * `cityName` the words for where it happens (the venue when there is one), `lat` and `lon`
 * the venue, and `flyTo` the city's name when the venue is elsewhere.
 */
export type PlaceEvent = { name: string; city: string; cityName: string; country: string; lat: number; lon: number; start: string; end: string; kind: PurposeEvent["kind"]; why: string; url?: string; km?: number; flyTo?: string };

/** Lower case, no diacritics, punctuation as spaces: "Tromsø" and "tromso" are one word. */
function foldName(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ø/gi, "o")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function kmBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The curated events at a place during a window: by city (a code such as "VCE" or a name
 * such as "Venice", accents ignored; the code is the city you fly to), by country (ISO2), or
 * by a point and a radius around the venue (default 150 km, so Glastonbury at Pilton shows
 * for Bath). An itinerary asks by point alone, so an event is planned only where it happens. Any one locator given is
 * enough; with none, nothing matches (this is "what is on here", not the whole list). Dates
 * are the edition that overlaps the window, nearest first, then by distance.
 */
export function eventsAt(q: { city?: string; country?: string; lat?: number; lon?: number; km?: number }, from: string, to: string): PlaceEvent[] {
  const cityRaw = (q.city ?? "").trim();
  const code = /^[A-Za-z]{3}$/.test(cityRaw) ? cityRaw.toUpperCase() : "";
  const cityWords = foldName(cityRaw);
  const country = /^[A-Za-z]{2}$/.test((q.country ?? "").trim()) ? q.country!.trim().toUpperCase() : "";
  const hasPoint = typeof q.lat === "number" && typeof q.lon === "number" && Number.isFinite(q.lat) && Number.isFinite(q.lon);
  const radius = typeof q.km === "number" && Number.isFinite(q.km) && q.km > 0 ? Math.min(q.km, 2000) : 150;
  if (!cityRaw && !country && !hasPoint) return [];
  const out: PlaceEvent[] = [];
  const seen = new Set<string>();
  for (const e of eventsInWindow(from, to)) {
    const km = hasPoint ? kmBetween(q.lat!, q.lon!, e.lat, e.lon) : undefined;
    // By city: the code you fly to (a place page for Edinburgh may show Up Helly Aa, with
    // Lerwick as its place), or the name of that city or of the venue.
    const byCity = !!cityRaw && ((code !== "" && e.code === code) || (cityWords !== "" && (foldName(e.city) === cityWords || (!!e.venue && foldName(e.venue.split(",")[0]) === cityWords))));
    const byCountry = country !== "" && e.country === country;
    const byPoint = km != null && km <= radius;
    if (!byCity && !byCountry && !byPoint) continue;
    // eventsInWindow may date one event in two years; a place page wants each edition once.
    const key = `${e.name}|${e.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: e.name, city: e.code, cityName: e.venue ?? e.city, country: e.country, lat: e.lat, lon: e.lon, start: e.start, end: e.end, kind: e.kind, why: e.note, ...(e.url ? { url: e.url } : {}), ...(km != null ? { km: Math.round(km) } : {}), ...(e.venue ? { flyTo: e.city } : {}) });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || (a.km ?? 0) - (b.km ?? 0));
}
