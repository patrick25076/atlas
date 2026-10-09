# Atlas

Where can you go from here, how, and for how much. A travel-intelligence globe that starts
from your location, finds the airports worth driving to, and draws what flies from each.

Built source by source. Every number on the globe says where it came from
(`public/data/manifest.json`, shown in the bottom-right chip).

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

## Stack decisions

New repo, web first (phone-sized layout included), MapLibre GL + deck.gl on OpenFreeMap tiles,
DuckDB for ingest, static JSON (later PMTiles) for the globe, Neon Postgres later for state.
