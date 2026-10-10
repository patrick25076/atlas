export type Airport = {
  iata: string;
  icao: string;
  name: string;
  city: string | null;
  country: string;
  region: string;
  size: "large" | "medium" | "small";
  lat: number;
  lon: number;
};

export type Route = {
  src: string;
  dst: string;
  airlines: number;
};

/** A city with at least one airport on the globe (public/data/cities.json). */
export type City = {
  name: string;
  country: string;
  lat: number;
  lon: number;
  /** IANA time zone, e.g. Europe/Bucharest. */
  tz?: string;
  /** Population of the biggest GeoNames town within 20 km. */
  pop?: number;
  airports: string[];
};

/** [name, lat, lon, country] per World Heritage site (public/data/heritage.json). */
export type HeritageRow = [string, number, number, string];

/** A cheapest return getaway found on Kiwi.com (public/data/deals.json). */
export type Deal = {
  /** Home airport. */
  gw: string;
  /** Destination airport or city code as searched. */
  dst: string;
  /** Destination city code on the globe. */
  dstCity: string;
  city: string;
  country: string;
  price: number;
  out: string;
  back: string;
  nights: number;
  stops: number;
  carriers: string[];
  outMin: number;
  backMin: number;
  url: string;
  bags?: string;
  /** Kiwi destination photo id: https://images.kiwi.com/photos/600x600/{img}.jpg */
  img?: string;
  /** Open-jaw: the flight home lands at this airport, booked separately (url2). */
  backTo?: string;
  url2?: string;
};
export type DealsFile = { updated: string; window: { from: string; to: string }; gateways: string[]; nights: [number, number]; deals: Deal[] };

/** Visa requirements (public/data/visa.json): one character per destination per passport. */
export type VisaFile = {
  updated: string;
  source: string;
  countries: string[];
  passports: Record<string, string>;
  days: Record<string, Record<string, number>>;
};

export const VISA_TEXT: Record<string, string> = {
  F: "visa-free, up to 90 days",
  S: "visa-free, short stay",
  L: "visa-free, longer stay",
  A: "visa on arrival",
  T: "electronic travel authorisation",
  E: "e-visa before travel",
  V: "visa required",
  N: "no admission",
  H: "home country",
};

export function visaFor(v: VisaFile, passport: string, destination: string): string | null {
  const row = v.passports[passport];
  const i = v.countries.indexOf(destination);
  if (!row || i < 0) return null;
  const code = row[i];
  if (!code || code === "?") return null;
  const days = v.days[passport]?.[destination];
  if ((code === "S" || code === "L") && days) return `visa-free, up to ${days} days`;
  return VISA_TEXT[code] ?? null;
}

/** One record per country (public/data/countries.json). */
export type CountryInfo = {
  name: string;
  currency?: string;
  /** Units of the currency per euro, today. */
  rate?: number;
  plugs?: string[];
  voltage?: number;
  languages?: string[];
  calling?: string;
  driving?: "left" | "right";
  advisory?: { warning: boolean; partial: boolean; situation: boolean; situationPart: boolean; updated: string };
};

export type Holiday = { date: string; name: string; localName: string; national: boolean };

/** Counts of places within ~5 km of a city centre (public/data/city-places.json, Overture). */
export type CityPlaces = Partial<Record<"food" | "cafe" | "bar" | "night" | "culture" | "nature" | "shop" | "stay", number>>;

/** One forecast day, per city code, after expanding the compact file. */
export type WeatherDay = { d: string; tmax: number; tmin: number; rain: number; sym: string };
/** `sea`: current sea surface temperature in °C for coastal cities. */
export type WeatherFile = { updated: string; cities: Record<string, WeatherDay[]>; sea: Record<string, number> };

/** On disk (public/data/weather.json): days run from `start` + `o`; `s` indexes `syms`. */
export type WeatherCompact = {
  updated: string;
  start: string;
  syms: string[];
  cities: Record<string, { o: number; t: number[]; n: number[]; r: number[]; s: number[] }>;
  sea?: Record<string, number>;
};

export function expandWeather(c: WeatherCompact): WeatherFile {
  const base = Date.parse(c.start);
  const cities: Record<string, WeatherDay[]> = {};
  for (const [code, w] of Object.entries(c.cities)) {
    cities[code] = w.t.map((tmax, i) => ({
      d: new Date(base + (w.o + i) * 86_400_000).toISOString().slice(0, 10),
      tmax,
      tmin: w.n[i],
      rain: w.r[i],
      sym: c.syms[w.s[i]] ?? "",
    }));
  }
  return { updated: c.updated, cities, sea: c.sea ?? {} };
}

export function compactWeather(updated: string, cities: Record<string, WeatherDay[]>, sea: Record<string, number> = {}): WeatherCompact {
  const dates = Object.values(cities).flatMap((d) => d.map((x) => x.d));
  const start = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : new Date().toISOString().slice(0, 10);
  const base = Date.parse(start);
  const syms: string[] = [];
  const symIndex = (s: string) => {
    let i = syms.indexOf(s);
    if (i < 0) i = syms.push(s) - 1;
    return i;
  };
  const out: WeatherCompact["cities"] = {};
  for (const [code, days] of Object.entries(cities)) {
    if (!days.length) continue;
    out[code] = {
      o: Math.round((Date.parse(days[0].d) - base) / 86_400_000),
      t: days.map((d) => d.tmax),
      n: days.map((d) => d.tmin),
      r: days.map((d) => d.rain),
      s: days.map((d) => symIndex(d.sym)),
    };
  }
  return { updated, start, syms, cities: out, sea };
}

export type ManifestEntry = {
  source: string;
  url: string;
  licence: string;
  note?: string;
  fetchedAt: string;
  rows: number;
  file: string;
};

export type Manifest = Record<string, ManifestEntry>;

/** An airport the user can realistically start from, with how far it is. */
export type Gateway = {
  airport: Airport;
  km: number;
  driveMin: number;
};

/** A cached fare from the Travelpayouts (Aviasales) data API: what people recently paid. */
export type Fare = {
  /** Departure airport on the globe (a city code in the API answer becomes the city's main airport). */
  src: string;
  /** Arrival airport on the globe. */
  dst: string;
  price: number;
  currency: string;
  departureAt: string;
  airline: string;
  flightNumber?: string;
  transfers: number;
  durationMin?: number;
  url: string;
};

export type FaresResponse = {
  status: "ok" | "no-token" | "error";
  origin: string;
  currency: string;
  fetchedAt?: string;
  note?: string;
  fares: Fare[];
};

/** A station reachable by train or coach, from /api/reach. */
export type ReachStation = {
  id: number;
  name: string;
  lat: number;
  lon: number;
  minutes: number;
  changes: number;
  mode: string;
  prev: number;
  /** Neighbouring stations on any line: 2 for a halt mid-line, 3+ for a junction. */
  links: number;
  /** Departures per day. */
  depDay: number;
  /** Population of the nearest town over 15,000 within 10 km (GeoNames), 0 when none. */
  pop: number;
  /** That town's name, when it differs from the station name. */
  town?: string;
};

export type ReachResponse = {
  starts: { id: number; name: string; lat: number; lon: number; minutes: number }[];
  reached: ReachStation[];
  generatedAt: string;
  feeds: { id: string; name: string; licence: string; attribution: string }[];
  stations: number;
  truncated?: boolean;
};

/** One arc on the globe: a gateway to somewhere it flies. */
export type Destination = {
  airport: Airport;
  from: Airport;
  km: number;
  /** Distinct airlines on the pair in the 2014 network; 0 when only a live fare knows the route. */
  airlines: number;
  fare?: Fare;
};
