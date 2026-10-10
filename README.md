# Atlas

The cheapest way to be somewhere else, from wherever you are, and what it is like there.
A globe (MapLibre and deck.gl) with a panel: live flight prices from Kiwi.com, nightly
price boards for about 150 airports worldwide, a custom period search, two-city combos,
long multi-country "wild" trips with a day-by-day plan, long stays, group trips, a price
calendar per destination, hotel prices and hotel deals, events from the cities' own open
feeds, sights from Wikivoyage, rated restaurants, and a chat agent that can call all of it.

Live: https://atlas-kappa-wheat.vercel.app

## Run it

```
pnpm install          # also copies MapLibre's worker into public/
pnpm dev -p 3210      # http://localhost:3210
pnpm typecheck
```

The committed `public/data/*.json` files are enough to run the globe. Flight prices come
from Kiwi.com's public search (no key). Everything else is optional and switches on when
its key appears in `.env.local` (copy `.env.example`; the names are listed there and the
accounts are explained step by step in `SETUP.md`):

| Key | What it switches on |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | the stored price boards, wild trips, plans and hotel snapshots (Vercel Blob) |
| `DATABASE_URL` | the shared fare memory, hotel price history, saved trips, the usage log (Postgres, Supabase pooler) |
| `AWS_BEARER_TOKEN_BEDROCK` | the Ask agent, the trip judge, the day planner |
| `LITEAPI_KEY` (+ `LITEAPI_ENV=production`) | hotel prices, the nightly hotel snapshot |
| `FOURSQUARE_API_KEY` | rated restaurants and sweet places |
| `TAVILY_API_KEY` | live web research for the planner and the agent |
| `TRAVELPAYOUTS_TOKEN`, `TRAVELPAYOUTS_MARKER` | cached one-way fares, commission on booking links |
| `TICKETMASTER_KEY` | ticketed events where no city feed exists |

Never commit `.env.local`. No real value belongs in the repository.

## Layout

| Path | What |
|---|---|
| `app/` | Next.js App Router: the page, the API routes under `app/api/*` |
| `components/Globe.tsx` | the globe, all client state, deck.gl layers |
| `components/Panel.tsx`, `TripsPanel.tsx`, `ChatPanel.tsx`, `FinderForm.tsx`, `RouteStrip.tsx`, `PriceLabels.tsx`, `TopBar.tsx` | the panel's tabs and widgets |
| `lib/` | server libraries: `kiwi.ts` (the one gate to Kiwi), `board.ts`, `finder.ts`, `scan.ts`, `wild.ts`, `longstay.ts`, `group.ts`, `plan.ts`, `combos.ts`, `agent-tools.ts`, `boards-store.ts` (Blob), `db.ts` (Postgres), `hotel-deals.ts`, `memo.ts`, `params.ts` |
| `scripts/ingest/` | the ingests that build `public/data/*.json` and the nightly jobs (`boards.ts`, `hotels.ts`) |
| `public/data/` | derived data, committed, with `manifest.json` saying where each file came from |
| `.github/workflows/refresh-data.yml` | the schedules: daily, weekly, monthly, nightly boards then hotels |
| `docs/architecture.md` | how it fits together, storage, jobs, costs, limits |
| `docs/data-inventory.md` | every data layer, coverage per region, what to add next |
| `docs/MORNING.md`, `docs/TODO.md` | the plain-language status and the running list |
| `SETUP.md` | every manual step outside the code, numbered |

## Data and licences

Every file in `public/data` is listed in `public/data/manifest.json` with its source,
licence and fetch date, and the globe shows it. Sources include OurAirports (public
domain), OpenFlights (ODbL), Travelpayouts static data, GTFS feeds from gtfs.de, SNCF,
Eurostar, FlixBus, Renfe, SNCB, Irish Rail, VIA Rail and the Romanian railways, MET Norway
(CC BY 4.0), NASA POWER climate normals, Frankfurter ECB rates, Wikidata (CC0), the German
Federal Foreign Office advisories, Nager.Date holidays, Overture Maps (CDLA-Permissive 2.0),
GeoNames (CC BY 4.0), the Passport Index dataset (MIT), Wikivoyage (CC BY-SA 4.0), World
Bank price levels, and twenty cities' own open event feeds (`docs/events-sources.md`).
Hotel prices come only from LiteAPI; restaurant ratings only from Foursquare. Nothing is
scraped from Google, Booking, Yelp or Tripadvisor.

## Jobs

`.github/workflows/refresh-data.yml` keeps the data fresh from GitHub's runners: the daily
set (weather, rates, advisories, holidays, airports), the weekly set (towns, ground graph,
one-way fares), the monthly set (places, ferries, heritage, visa, fame, costs, climate) and,
every night at 01:00 UTC, the price boards for about 150 airports (eight shards, `pnpm
ingest:boards`) followed by the hotel snapshot (`pnpm ingest:hotels`). The first three
commit `public/data` and redeploy; the nightly two write to Blob (and Postgres) only. Run
any set by hand from the Actions tab.
