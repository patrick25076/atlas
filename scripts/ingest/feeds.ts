// The ground-transport feeds we ingest. One entry per GTFS feed; adding a country is adding
// a line here. Keep `licence` and `attribution` exact: they are shown in the app.
export type Feed = {
  id: string;
  name: string;
  url: string;
  licence: string;
  attribution: string;
  countries: string[];
  /** What the feed mostly is; the real mode per edge comes from routes.txt route_type. */
  mode: "rail" | "coach" | "mixed";
};

export const FEEDS: Feed[] = [
  {
    id: "de-fv",
    name: "Germany long-distance rail (ICE/IC/EC)",
    url: "https://download.gtfs.de/germany/fv_free/latest.zip",
    licence: "CC BY 4.0",
    attribution: "gtfs.de",
    countries: ["DE"],
    mode: "rail",
  },
  {
    id: "ro-rail",
    name: "Romanian railway operators (CFR Călători and private operators, cross-border to HU/BG/MD)",
    url: "https://files.mobilitydatabase.org/mdb-3236/latest.zip",
    licence: "OGL-ROU 1.0 (Romanian Open Government Licence)",
    attribution: "S.C. Informatică Feroviară S.A. via Mobility Database (mdb-3236)",
    countries: ["RO", "HU", "BG", "MD"],
    mode: "rail",
  },
  {
    id: "fr-sncf",
    name: "SNCF: TGV, Intercités and TER",
    url: "https://files.mobilitydatabase.org/tdg-83582/latest.zip",
    licence: "ODbL 1.0",
    attribution: "SNCF via transport.data.gouv.fr (tdg-83582)",
    countries: ["FR"],
    mode: "rail",
  },
  {
    id: "eurostar",
    name: "Eurostar",
    url: "https://files.mobilitydatabase.org/tdg-82199/latest.zip",
    licence: "Licence Ouverte / Etalab 2.0",
    attribution: "Eurostar International Ltd. via transport.data.gouv.fr (tdg-82199)",
    countries: ["GB", "FR", "BE", "NL", "DE"],
    mode: "rail",
  },
  {
    id: "flixbus-eu",
    name: "FlixBus and FlixTrain, European network",
    url: "https://files.mobilitydatabase.org/tdg-11681/latest.zip",
    licence: "ODbL 1.0",
    attribution: "FlixBus via transport.data.gouv.fr (tdg-11681)",
    countries: ["EU"],
    mode: "mixed",
  },
  // ÖBB (Austria): CC BY 4.0 but the download sits behind a click-to-accept page at
  // https://data.oebb.at/de/datensaetze~soll-fahrplan-gtfs~ . Manual step (SETUP.md §9).
];
