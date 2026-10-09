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

/** One arc on the globe: a gateway to somewhere it flies. */
export type Destination = {
  airport: Airport;
  from: Airport;
  km: number;
  airlines: number;
};
