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
  /**
   * Which routes of the feed to keep (all when absent). A national feed that bundles a
   * capital's city buses with the intercity trains would otherwise add thousands of bus
   * stops that nobody travels between cities on.
   */
  keep?: {
    /** GTFS route_type values to keep (2 rail, 3 coach, 4 ferry; 0 tram, 1 metro). */
    routeTypes?: number[];
    /** agency_id values to drop, for urban operators inside a national feed. */
    dropAgencies?: string[];
  };
  /**
   * Fastest straight-line average (km/h) a timed connection in this feed can honestly run at,
   * per mode; a time implying more is a placeholder and the ingest estimates it by distance.
   * Absent modes use the defaults in gtfs.ts (rail 350, a TGV leg). A network with no fast
   * trains needs a lower ceiling, or compressed placeholder times slip through as real ones.
   */
  maxKmh?: Partial<Record<"rail" | "coach" | "ferry" | "other", number>>;
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
  {
    id: "es-renfe",
    name: "Renfe: high-speed, long-distance and media distancia",
    url: "https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip",
    licence: "CC BY 4.0",
    attribution: "Renfe via data.renfe.com",
    countries: ["ES"],
    mode: "rail",
  },
  {
    id: "be-sncb",
    name: "SNCB/NMBS (Belgium)",
    url: "https://files.mobilitydatabase.org/mdb-1859/latest.zip",
    licence: "SNCB open data (see gtfs.be)",
    attribution: "NMBS-SNCB via Mobility Database (mdb-1859)",
    countries: ["BE"],
    mode: "rail",
  },
  {
    id: "ie-rail",
    name: "Irish Rail",
    url: "https://files.mobilitydatabase.org/mdb-2637/latest.zip",
    licence: "NTA open data (transportforireland.ie)",
    attribution: "Iarnród Éireann via Mobility Database (mdb-2637)",
    countries: ["IE"],
    mode: "rail",
  },
  // Outside Europe (added 2026-10-10 from the Mobility Database catalog, feeds_v2.csv). Each
  // was downloaded and opened before it was added; the licence line says what the publisher
  // states, and "no explicit licence" means a feed the operator publishes for developers
  // without a licence text next to it.
  {
    id: "ca-via",
    name: "VIA Rail Canada",
    url: "https://files.mobilitydatabase.org/mdb-735/latest.zip",
    licence: "VIA Rail developer terms (viarail.ca/en/developer-resources)",
    attribution: "VIA Rail Canada via Mobility Database (mdb-735)",
    countries: ["CA"],
    mode: "rail",
  },
  {
    // Flix's own feed; the Mobility Database entry (mdb-593) is a stale 2024 copy marked
    // inactive. One file covers both brands in the US, with cross-border runs to Canada and Mexico.
    id: "flix-us",
    name: "FlixBus and Greyhound, United States network",
    url: "https://gtfs.gis.flix.tech/gtfs_generic_us.zip",
    licence: "Flix open GTFS (gtfs.gis.flix.tech, no explicit licence; the EU twin is ODbL on transport.data.gouv.fr)",
    attribution: "Flix SE (FlixBus, Greyhound)",
    countries: ["US", "CA", "MX"],
    mode: "coach",
  },
  // The three below have no parent_station column in stops.txt; gtfs.ts falls back to stop_id
  // since 2026-10-10 (before that they crashed the ingest, which is why they waited).
  {
    id: "us-amtrak",
    name: "Amtrak (all routes, plus Thruway connecting coaches)",
    url: "https://files.mobilitydatabase.org/mdb-11/latest.zip",
    licence: "Amtrak public GTFS (content.amtrak.com/content/gtfs, no explicit licence)",
    attribution: "Amtrak via Mobility Database (mdb-11)",
    countries: ["US", "CA"],
    mode: "mixed",
  },
  {
    id: "my-ktm",
    name: "KTM Malaysia: ETS and intercity trains, Komuter",
    url: "https://files.mobilitydatabase.org/tld-6758/latest.zip",
    licence: "Malaysian Government open data terms (data.gov.my)",
    attribution: "Keretapi Tanah Melayu Berhad via Mobility Database (tld-6758)",
    countries: ["MY", "TH", "SG"],
    mode: "rail",
  },
  {
    // The whole country in one feed (42 MB zip, mostly shapes; 17,000 stops, 2,066 routes).
    // Kept: State Railway of Thailand trains (route_type 2, 188 routes), the intercity coaches
    // of Transport Co. (บขส), Nakhonchai Air, Sombat Tour and about a hundred regional
    // operators (route_type 3), and the island ferries and speedboats (route_type 4).
    // Dropped: Bangkok's BTS, MRT, Red Line and Airport Rail Link (route_type 0 and 1), and the
    // Bangkok urban bus and boat operators named in dropAgencies: DLT (the Department of Land
    // Transport's ต. minibus routes, 11,800 stops), BMTA and Thai Smile Bus (city buses), BMA,
    // the Chulalongkorn campus shuttle, and the Chao Phraya and khlong boats. That leaves
    // about 1,300 stops instead of 16,900.
    id: "th-otp",
    name: "Thailand national GTFS (OTP): State Railway trains, intercity coaches, island ferries",
    url: "https://files.mobilitydatabase.org/mdb-1831/latest.zip",
    licence: "CC BY 4.0",
    attribution: "Office of Transport and Traffic Policy and Planning (Thailand) via Mobility Database (mdb-1831)",
    countries: ["TH"],
    mode: "mixed",
    keep: {
      routeTypes: [2, 3, 4],
      dropAgencies: ["DLT", "BMTA", "TSB", "TSB (BOAT)", "BMA", "PMCU", "ST", "BTK"],
    },
    // The feed's train times are placeholders: Bangkok to Chiang Mai (577 km) is timed at
    // 7 minutes, and the shorter runs are compressed too (Bangkok to Ayutthaya 17 minutes for
    // 70 km). SRT's line speed limit is 120 km/h and its fastest services average under
    // 70 km/h in a straight line (Chiang Mai special express 52, Hua Hin express 62), so a pair
    // timed above 80 is compressed, not fast; coaches on the expressways stay under 100.
    // Checked 2026-10-10 against the feed: 1,040 of 14,000 timed rail pairs sat between 80 and
    // 120 km/h, all of them compressed placeholders.
    maxKmh: { rail: 80, coach: 100 },
  },
  // Looked for and not added (catalog of 2026-10-10): Japan has only local feeds (ODPT, JBDA),
  // no JR intercity; South Korea, India, Mexico, Brazil, Argentina, Chile, South Africa list
  // only city networks or inactive feeds (Trenes Argentinos mdb-647 is inactive, EFE Chile sits
  // inside the Santiago urban feed); NSW TrainLink needs a Transport for NSW API key; V/Line
  // comes only inside the PTV Victoria zip, which nests one zip per mode (this ingest reads
  // flat zips); New Zealand's InterCity coach feed (mdb-1144) is inactive and KiwiRail has none.
  // Not yet: CP Portugal (mdb-2057) and Trenitalia (mdb-1052) list no licence in the catalog;
  // NS Netherlands is not in it; Trafiklab (SE/NO) feeds need a key. Verify before adding.
  // ÖBB (Austria): CC BY 4.0 but the download sits behind a click-to-accept page at
  // https://data.oebb.at/de/datensaetze~soll-fahrplan-gtfs~ . Manual step (SETUP.md §9).
];
