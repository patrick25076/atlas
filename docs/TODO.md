# Atlas: what is done, what is wired, what is still needed

_Kept by the agent; updated every session. Plain language._

## Keys and accounts

| Service | Status | What it gives | Still needed |
|---|---|---|---|
| Kiwi.com public search | working, no key | all flight prices and booking links | nothing (terms unpublished; watch) |
| Vercel + Blob store | done | hosting, stored boards, trips, plans | nothing |
| Bedrock (GPT-6 Astra) | done | Ask agent, trip judge, day planner | nothing; `ASK_MODEL` switches models |
| Travelpayouts | done: Drive script, marker 583720, API token (2026-10-10) | Kiwi clicks earn commission; cached one-way fares (Explore, Trips) with marker links | join more programs inside Travelpayouts (Airalo, Omio, Hostelworld, Klook) for more earning links |
| Tavily search | key saved 2026-10-10, wired in | live review research for the planner and Ask | nothing (free tier ~1,000 searches a month; a plan uses about 10) |
| Foursquare Places | done 2026-10-10: card on file, auto-recharge $20, 500 free Pro calls | restaurant ratings, price tiers, tips on deal pages, in plans and in Ask | watch the Transactions table after a few days to see credits per call; we cache every city a day (two calls per city per day at most). Reset the OAuth client secret you pasted (not used) |
| LiteAPI | done 2026-10-10: production key, live prices on deal pages | hotel prices; booking next | nothing |
| Ticketmaster | skipped for now | concerts and shows outside the 20 city feeds | a free key, when you want it |
| DiscoverCars | skipped for now | car hire commission | an affiliate id, when you want it |
| Viator Basic | applied, takes time | bookable experiences with commission | the key when it arrives |
| Tiqets | applied, takes time | attraction tickets | the key when it arrives |
| opentransportdata.swiss | not yet | Switzerland on the ground map | a free key |
| ÖBB GTFS | not yet | Austria on the ground map | the zip in `data/raw/` |
| **Postgres (Supabase)** | project exists (ref `<project-ref>`, eu-west-1); a pooler string on port 6543 works from this laptop (the hotel snapshot wrote rows on 2026-10-10) and is a GitHub secret | the shared fare memory (every fare anyone saw, timestamped), hotel price history, saved trips, search log | **reset the password that was pasted in chat**, then put the new pooler string in `.env.local`, Vercel (Production) and the GitHub secret; confirm it is on Vercel (SETUP §4) |
| GitHub repository | **public** since 2026-10-10; Actions minutes unlimited; secrets `BLOB_READ_WRITE_TOKEN`, `LITEAPI_KEY`, `DATABASE_URL` | nightly boards and the hotel snapshot run from GitHub | nothing |

## Decisions waiting on you

- **The Supabase password**: it was pasted in chat, so reset it (SETUP §4) and update the
  three places. Until then the database is "works but not trusted".
- **LiteAPI in writing**: the nightly hotel snapshot keeps one price per city per night. Their
  terms forbid "creating databases"; a sample for deals is defensible but an email asking is
  cheaper than an argument (SETUP §5, point 3).

## Built and live

Worldwide price boards (nightly for ~150 airports, live for the rest), month search, deals
with photos and badges, price tags on the globe, two-city combos, sights from Wikivoyage with
pins, festivals, what's on from 20 city feeds, hidden gems, Ask agent, wild trips with
preferences into 14 regions, the judge, the day-by-day planner with food and monthly costs.

## Round three, 10 October, night: "Been"

- The optional Been feature end to end: `lib/been.ts`, the top-bar pill and `components/BeenEditor.tsx`,
  `exclude=` on every search route and engine (finder, scan, wild + plan keys, longstay, group, purpose,
  combos, trips), client-side filtering of boards, the "been" tag, the one-line note on the forms, and the
  chat agent (`exclude` / `allow` on every searching tool, the Been line in the system prompt). Layovers
  are never excluded. See `docs/plans/been-feature.md`.
- `scripts/ingest/fame.ts` checks each Wikipedia article and Wikivoyage guide against the city's
  coordinates (namesakes refused; "Name, State" and geosearch fallbacks); `public/data/fame.json`
  regenerated: 2,758 cities.
- Leftovers closed: region lookups guarded with `Object.hasOwn` in the wild, plan and longstay routes and
  the agent tools; `/api/longstay` answers 400 for input errors; the Travelpayouts snippet loads only on
  production hosts.

## Round two, 10 October, night (four streams again; the first attempt was killed by memory)

- **Infrastructure**: Kiwi's memo key is normalised (case, spacing of the place name) and a
  403 or 429 opens a five-minute circuit breaker (`kiwiStats().throttledUntil`), so a
  throttled address is left alone instead of hammered; `lib/db.ts` returns ISO dates and
  timestamps from every query and retries the schema once; the usage log (`searches`) is
  written fire-and-forget from the finder, wild, scan, longstay, group and live board routes
  (kind, parameters without personal data, results, ms); hotel deals compare a city only
  with earlier snapshots of the **same check-in weekend** (three needed; the window rolls to
  the next Friday every Saturday, so each week's Saturday and Sunday are warming up and the
  deals show Monday to Friday), the history is read by expected paths, Postgres first, no
  Blob listing; `/api/wild` and `/api/plan` build ranked versions for a dated window too and
  clip a window wider than ten days instead of refusing it; `/api/finder` takes
  `maxHours=0` as no limit; `pnpm ingest:hotels` is the job's command; `SETUP.md` sections
  are in order 1 to 15 with the Supabase ref as `<project-ref>` (the repo is public) and a
  note on the Flix US feed; `docs/architecture.md` has the rollover and the usage log.
  After the second review: `ensureSchema` remembers a failed database for a minute (two
  5 s connect timeouts once, then instant no-ops) instead of 21 s per call; the hotel
  history merges Postgres and Blob (Blob skipped only when Postgres holds a real night for
  the weekend) and a complete-but-thin night says "priced only N of 80 cities"; a search
  held back by the breaker is not counted as sent; `post()` times out at 30 s and retries
  as a 503; `maxHours` at or below 0 is no limit and a fraction rounds up; the group route
  uses `lib/params.isoDay` (no rolled-over dates).
- **Brain**: `hotel_deals`, `scan_cheapest`, `long_stay`, `group_trip`, `best_months`,
  `price_insight` and `stopover_programmes` are chat tools; wild trips take a departure
  window (`from`, `to`) and up to 90 nights; a per-turn search budget (`TURN_SEARCH_BUDGET`)
  bounds what one question may cost; city names are accepted where codes were.
- **Visual**: the Deals tab shows a hotel deals strip (`components/HotelDeals.tsx`, hidden
  until there are deals); the long stay and group forms live in Globe state and survive a
  tab change; the Globe sends `/api/plan` every parameter of the trip's key, so "Plan the
  days" finds the customised trips.
- **Engine and data**: the ground graph gained Amtrak, KTM Malaysia and Thailand's intercity
  feed (`feeds.ts`, with a `keep` filter that drops Bangkok's city buses; in the graph after
  the next weekly run); the GTFS ingest caps DuckDB at 2 GB and two threads; the fame ingest
  refuses namesake articles by distance (Glasgow, Montana no longer borrows Glasgow's fame).

## Built 10 October, afternoon, by four parallel streams

- **Engine** (`lib/scan.ts`, `lib/longstay.ts`, `lib/group.ts`, `lib/climate.ts`,
  `lib/insights.ts`, `scripts/ingest/climate.ts`, `/api/scan`, `/api/longstay`, `/api/group`,
  `/api/insights`): the price calendar ("cheapest whenever": one Kiwi search per month, the
  fare memory first, open-jaw optional); long stays (one to three months: the eight best
  bases of a region by worth for money, flight in and out, rent and living from the World
  Bank index, side trips, climate, visa); group trips (several people from different airports
  meeting somewhere: common windows, then the cheapest city for everyone); climate normals
  for 1,496 cities (NASA POWER, the monthly job fills the rest) and "best months"; price
  insight (is this fare great, good, typical or high for the route and month, from the fare
  memory); wild trips up to 90 nights with the nights per stop scaling.
- **Brain** (`components/ChatPanel.tsx`, `lib/chat-widgets.ts`, `lib/agent-tools.ts`,
  `app/api/chat/route.ts`): the chat gained the new engines as tools (scan_cheapest,
  long_stay, group_trip, best_months, price_insight, stopover_programmes, events worth
  travelling for), widgets inside the conversation (date and month pickers, nights, a region
  picker, people rows for a group), and the bridge to the globe: `atlas:pick` asks the globe
  for a region, dates or a place, `atlas:picked` answers.
- **Visual** (`components/Globe.tsx`, `TripsPanel.tsx`, `RouteStrip.tsx`, `Panel.tsx`,
  `PriceLabels.tsx`, `lib/arc.ts`, `lib/format.ts`, `lib/ui-types.ts`): one Trips tab for
  every kind of trip with a mode row; any trip drawn the same way (the loop as a strip of
  photos, stops as cards, legs as rows with booking links); the globe answers the chat's
  pick requests; more GTFS feeds in the ground graph (Renfe, SNCB, Irish Rail, VIA Rail,
  FlixBus US; Amtrak, Malaysia and Thailand queued).
- **Infrastructure** (this stream): one gate to Kiwi (6 concurrent, a 24-hour memo per exact
  search, a daily counter), bounded memos in every route, a ten-minute cache in front of
  Blob, validation with plain 400s, keep-alive progress lines on the streams, `maxDuration`
  per route; the nightly hotel snapshot (80 cities, LiteAPI, Blob and Postgres) and
  `/api/hotel-deals` (a city is a deal at 25% under its own median, after three snapshots;
  **the route exists, nothing shows it yet**: no chat tool, no strip in the Deals tab, see
  "Next on the list"); boards nightly again, hotels after them, climate in the monthly set;
  `docs/architecture.md`, `docs/data-inventory.md`, `README.md`, SETUP §4 rewritten for the
  Supabase pooler.
- **The chat rewrite** (brain stream, evening): the chat acts first and asks one widget
  question at most, shows a price calendar, keeps threads, takes voice; `lib/chat-widgets.ts`
  is the shared widget contract between the chat and the globe.

## Fixed 10 October, evening (after two adversarial reviews)

- Kiwi gate: the 120 ms pacing now reserves the start time under the lock (six callers waking
  together no longer start in the same millisecond); a 400/404 counts as an attempt (three,
  then an error) instead of looping for the whole `maxDuration`; a hard daily budget of 1,500
  live searches per process (`KIWI_DAILY_BUDGET`), refused with a plain message past it;
  throttling reads as one sentence the chat can show.
- `fresh=` on `/api/board`, `/api/wild` and `/api/plan` needs the shared `ATLAS_FRESH_TOKEN`
  (SETUP §15); a public URL cannot be reloaded into hundreds of searches.
- Wild variants capped at 3 (2 past 28 nights, about 200 searches a click at most); a dated
  window with variants builds one trip until `lib/wild-variants.ts` keys each version on the
  window (handed to the engine stream), so December trips are never answered with versions
  built for other dates.
- `/api/plan` accepts tradeoff, noHubs, from, to and variants and looks the trip up under the
  same key `/api/wild` stored it with (the Globe must send them; handed to the visual stream).
- An all-failed finder, purpose or combos run is answered with a note and not memoised, so a
  throttled minute never becomes "no deals" for half an hour.
- Boards: fresh for 26 hours (the nightly runs at 01:00 UTC), live rebuilds of a home-market
  airport search the favourite destinations too, and a thinner live board never replaces a
  richer stored one unless that one is two days old.
- Blob reads: only a real 404 is cached as missing; any other failure serves the last copy
  the instance saw, so a Blob hiccup never turns into a wave of live rebuilds.
- Hotel snapshot: a limited or sandbox run writes `hotels/test-<date>.json` only (never
  `latest.json`, never Postgres) unless `HOTELS_WRITE=1`; snapshots carry `sandbox` and
  `complete` marks; the history ignores sandbox snapshots and any day with fewer than 40
  cities, so the three-city test of 2026-10-10 is out of every median without a delete.
- `cheapestSeen` in `lib/db.ts` takes a list of airports and a city name, so the scan can
  find a remembered fare into any airport of Bangkok or London in one query (engine stream).
- The monthly job runs `pnpm ingest:climate` directly (the script exists).

## Built today, evening

- **The chat is now the agent.** "Ask" tab: a persistent conversation (kept in your browser)
  that knows where you are, your airports, your passport and the selected month, streams its
  answer, and calls every Atlas capability as a tool: tonight's boards, the period search,
  live re-pricing, two-city combos, wild trips (with custom country lists), day plans, sights,
  events, rated restaurants, hotels, one-way fares, trains, facts, web search. Results appear
  as cards in the chat and as pins or a route on the globe; "make it direct", "from Cluj too",
  "what do I eat there" continue the thread. The top-bar box sends into the same chat.

## Built today, afternoon

- Bigger type and lists everywhere (panel 468px, 14 to 17px text, visible scrollbar).
- Wild trips fly home into any of your airports and add the last leg to your door (Bucharest →
  Brașov by train or car), try a stopover night in a hub on the way back when it costs about
  the same, and Trips work from any airport (Travelpayouts cached fares).
- Hidden-city ("skiplag") scan as an opt-in in the custom search, shown with the warning.
  flightlist.io is a front end on the same Kiwi engine; nothing to integrate.
- Custom search ("Finder") in the Deals tab: a period, a date you must be away on, nights from
  and to, which of your airports, anywhere or a region or a country, direct, max hours, and
  "flying home may land at" another of your airports (open-jaw, two tickets).
- Travelpayouts token: cached one-way fares with marker links in Explore and Trips.

## What is left (honest list, 10 October, night)

- **The Supabase password** pasted in chat: reset it, then the new pooler string into
  `.env.local`, Vercel (Production) and the GitHub secret; confirm `DATABASE_URL` is on
  Vercel (SETUP §4). Until then: works, not trusted.
- **Two emails**: LiteAPI about the nightly price sample (SETUP §5, point 3) and
  open-data@flixbus.com about the US feed (SETUP §9; `docs/data-inventory.md` says
  "permission pending" until the answer).
- **The first hotel deals** need three snapshots of the same weekend: the nightly job's
  first full run is the night of 11 October (check-in Friday 13 November), so the first
  deals appear from 13 October, pause on 17 and 18 October (the window rolls to 20
  November) and return from 19 October; every week the same shape. The three-city test rows
  of 2026-10-10 are ignored (a day needs 40 cities); delete them when convenient.
- **`.tmp/` holds 1.8 GB of DuckDB spill files** from the killed GTFS run; it is not in
  `.gitignore`. Delete the folder and add `.tmp/` to `.gitignore` (tooling owner).
- **Round-two code is uncommitted**: everything in this list and the section above sits in
  the working tree; commit by path once the four streams' reports are read.
- The usage log has no reader yet: a `/api/stats` or a nightly line in the job log would
  turn the `searches` table into numbers.
- Hotel booking through LiteAPI (prices and the nightly snapshot are wired; booking is not).
- Viator experiences in the plan once the key arrives.
- Set `ATLAS_FRESH_TOKEN` on Vercel (SETUP §15) if you ever want to force a rebuild from the
  browser; without it `fresh=` is simply ignored.

## Next on the list
- Data sources recorded this session: climate normals come from **NASA POWER** (public
  domain, cite "NASA POWER Project, https://power.larc.nasa.gov"); the ground graph gained
  **VIA Rail Canada** ("VIA Rail developer terms, viarail.ca/en/developer-resources", via the
  Mobility Database, mdb-735) and **FlixBus and Greyhound US** ("Flix open GTFS,
  gtfs.gis.flix.tech, no explicit licence; the EU twin is ODbL on transport.data.gouv.fr").
  The wording is `scripts/ingest/feeds.ts` and is shown in the app.
- A shared memo across Vercel instances (the `fares` table already holds every result; the
  scan reads it first, the board and finder could too), then a queue for live searches, if
  traffic ever makes Kiwi throttle Vercel's addresses (`docs/architecture.md`).
- Sources ranked in `docs/data-inventory.md`: Open-Meteo marine (sea temperature everywhere),
  Travelpayouts current routes (replacing the 2014 network), Transitous ground routing,
  OpenAgenda events, LiteAPI reviews.
