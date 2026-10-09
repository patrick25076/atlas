# Atlas

Where can you go from here, how, and for how much. A travel-intelligence globe that starts
from your location, finds the airports worth driving to, and draws what flies from each.

Built source by source. Every number on the globe says where it came from
(`public/data/manifest.json`, shown in the bottom-right chip).

## Layout

| Path | What |
|---|---|
| `app/` | Next.js app router: layout, page, global styles |
| `components/Globe.tsx` | MapLibre globe + deck.gl layers (airports, gateways, arcs) |
| `components/Panel.tsx` | Side panel: origin search, gateways, destinations |
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

## Stack decisions

New repo, web first (phone-sized layout included), MapLibre GL + deck.gl on OpenFreeMap tiles,
DuckDB for ingest, static JSON (later PMTiles) for the globe, Neon Postgres later for state.
