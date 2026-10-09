# Atlas

The cheapest getaways from where you are, and what it is like there. A globe with three tabs:

- **Deals**: real return prices for the next six weeks from the home airports (Kiwi.com,
  searched nightly), as cards with a photo, dates, airline and a booking button.
- **Explore**: every place within ten hours by plane, train, coach or ferry, with the best
  way there and a door-to-door estimate.
- **Trips**: three-countries-in-five-days loops priced from one-way fares.

Plus **Ask**, a concierge agent over the same data, and a place card with weather, sea
temperature, money, plugs, languages, visa for your passport, warnings, holidays, World
Heritage nearby, how many restaurants and bars, and a Wikivoyage paragraph.

Built source by source. Every number on the globe says where it came from
(`public/data/manifest.json`, shown in the bottom-right chip). `docs/MORNING.md` is the
plain-language status and the list of keys still needed.

## Layout

| Path | What |
|---|---|
| `app/` | Next.js app router: layout, page (reads Vercel's location hint), global styles |
| `app/api/fares` | Cheapest cached one-way fares per destination for an origin (Travelpayouts) |
| `app/api/reach` | Stations reachable by train and coach from a point (Dijkstra over the ground graph) |
| `components/Globe.tsx` | MapLibre globe + deck.gl layers; three views: any way, by air, by train and coach |
| `components/Panel.tsx` | Side panel (bottom sheet on phones): origin search, places, gateways, destinations |
| `lib/places.ts` | The combined view: one place per city, best mode, door-to-door estimate, price |
| `lib/ground.ts` | Ground graph in memory, reach search with frequency-based expected waits |
| `lib/travelpayouts.ts` | Fares API client; maps city codes to airports; booking links with the marker |
| `lib/geo.ts` | Haversine, gateway selection, drive and flight time estimates |
| `scripts/ingest/` | DuckDB scripts that turn a source into `public/data/*.json` |
| `public/data/` | Derived data, committed so a deploy needs no ingest |
| `SETUP.md` | Manual steps (accounts, keys), numbered |

## Data sources so far

| Source | Licence | Used for | Refresh |
|---|---|---|---|
| OurAirports | Public domain | Airports with scheduled service (nodes) | nightly upstream; `pnpm ingest:airports` |
| OpenFlights routes | ODbL, frozen 2014 | Indicative network (which pairs were ever connected) | placeholder; dims once fares are live |
| Travelpayouts airports.json | free static data | City code → airports mapping for the fares API | `pnpm ingest:tp-airports`, monthly |
| Travelpayouts / Aviasales Data API | free with token (SETUP §2) | Cheapest cached one-way fare per destination, booking links with the marker | live, cached 1 h per origin |
| GTFS feeds (`scripts/ingest/feeds.ts`): gtfs.de long-distance (CC BY 4.0), Romanian railways (OGL-ROU 1.0), SNCF TGV/Intercités/TER (ODbL), Eurostar (Etalab 2.0), FlixBus + FlixTrain Europe (ODbL) | per feed | Ground graph: 7.4k stations, 220k direct connections, walking transfers; `/api/reach` Dijkstra with expected waits | `pnpm ingest:gtfs`, weekly |
| MET Norway locationforecast + oceanforecast | CC BY 4.0 | 7-day forecast for 2,805 cities; weather strip, "Warm this weekend"; sea temperature for cities within 15 km of a ferry port | `pnpm ingest:weather`, nightly |
| Frankfurter (ECB rates) | free, commercial OK | Today's rate per euro, 104 countries | `pnpm ingest:countries`, daily |
| Wikidata | CC0 | Plug types and voltage, 223 countries | monthly |
| German Federal Foreign Office | open data | Travel warnings, full and partial, 200 countries | daily |
| Nager.Date | open source | 2,878 public holidays, 204 countries, next 400 days; home holidays become trip-date chips | `pnpm ingest:holidays`, weekly |
| Wikivoyage | CC BY-SA 4.0 | One paragraph per place, live via `/api/place`, cached a day, attributed | live |
| Travelpayouts cities.json | free static data | City names, coordinates, time zones (local time on the card) | `pnpm ingest:tp-airports`, monthly |
| Overture Maps places (S3 parquet via DuckDB) | CDLA-Permissive 2.0 | Counts of restaurants, cafés, bars, nightlife, culture, nature, shops, lodging within ~5 km of 2,707 cities; no places stored | `pnpm ingest:overture`, monthly |
| Overture Maps transportation (water segments) | CDLA-Permissive 2.0 | Named ferry routes with ports → estimated crossings in the ground graph | `pnpm ingest:ferries`, monthly |
| GeoNames cities15000 | CC BY 4.0 | 34k towns with population; city population, town names for stations, "big places" ranking | `pnpm ingest:geonames`, monthly |
| Wikidata: World Heritage Sites | CC0 | 1,887 sites; the nearest within 60 km on the card | `pnpm ingest:heritage`, monthly |
| Wikidata: country facts | CC0 | Plugs, voltage, official languages, calling code, driving side | with `ingest:countries` |
| Passport Index dataset (imorte, continuing ilyankou) | MIT | Visa requirement for the visitor's passport at each destination, labelled indicative with the dataset date | `pnpm ingest:visa`, monthly |
| Kiwi.com public MCP (`lib/kiwi.ts`) | no key; terms not published | **Deals**: cheapest return getaways from the home airports × 117 cities, 6-week window, 2-7 nights, with booking links; **one-way fares** for the trip finder; `/api/deals` live re-price | `pnpm ingest:deals`, `pnpm ingest:oneway`, nightly |
| Amazon Bedrock (AI SDK) | your credits | **Ask**: a concierge over the deals and place facts, `/api/ask` (needs `AWS_BEARER_TOKEN_BEDROCK`) | live |
| Ticketmaster Discovery | free key | events near a place, `/api/events` (needs `TICKETMASTER_KEY`) | live, cached 6 h |

## Refresh

`.github/workflows/refresh-data.yml` re-runs the ingests on a schedule (daily, weekly on
Monday, monthly on the 1st) and commits `public/data`, which redeploys production. Run it by
hand from the Actions tab with the set you want. Locally: `pnpm ingest` for the daily set,
`pnpm ingest:gtfs` for the ground graph, `pnpm ingest:overture` for the place counts.

## Stack decisions

New repo, web first (phone-sized layout included), MapLibre GL + deck.gl on OpenFreeMap tiles,
DuckDB for ingest, static JSON (later PMTiles) for the globe, Neon Postgres later for state.
