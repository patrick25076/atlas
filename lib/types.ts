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
  airports: string[];
};

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
