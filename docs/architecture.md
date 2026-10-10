# Atlas: how it fits together

_Written 2026-10-10 for whoever works on this next. Plain language, the numbers as they stand._

## One sentence

A Next.js 16 app on Vercel: a MapLibre globe with a panel, a set of server routes that turn
one price source (Kiwi.com's public flight search) plus a few dozen open data files into
deals, trips, plans and answers, a Blob store for anything rebuilt nightly, an optional
Postgres for anything worth remembering, and GitHub Actions as the only scheduler.

## The layers, bottom up

### 1. Static data (`public/data/*.json`, committed)

Built by `scripts/ingest/*.ts`, each one records its source, licence and date in
`manifest.json`. Loaded into memory by the server routes with a plain import, so a route has
every city, airport, country fact, forecast, place count, fame score, climate normal, visa
rule and holiday at hand without a database. Sizes: 14 MB on disk, of which the ground graph
is 7 MB (12,959 stations, 327k direct connections). `docs/data-inventory.md` lists every
file with its coverage.

### 2. The price source: Kiwi.com through `lib/kiwi.ts`

Every flight price on the site comes through one function, `searchFlight(args)`, which
speaks JSON-RPC to Kiwi's public MCP server (no key, terms unpublished). One search returns
the 15 cheapest itineraries with booking links. Kiwi accepts several origins in one call, a
country as the destination, and date ranges for both legs, which is why a whole board is
about 35 searches and a six-month price calendar is six.

`lib/kiwi.ts` is the one gate, and it is where the scale rules live:

- at most **6 searches in flight per process** (`KIWI_MAX_CONCURRENT`), 120 ms between starts
  (the start time is reserved under the lock, so six callers waking together still start one
  after the other);
- a **24-hour memo keyed by the normalised arguments** (500 entries, least recently used):
  `flyTo` is trimmed, lower cased and its whitespace collapsed, `flyFrom` upper cased, so
  "San Francisco" and "san  francisco" are one key; the same search is never sent twice from
  one process, and identical searches in flight share one promise;
- a **daily counter** that logs at 250, 500, 1,000, 1,500, 2,000 and every 500 after, because
  Kiwi throttles an address after a couple of thousand searches a day, and a **hard daily
  budget** (`KIWI_DAILY_BUDGET`, 1,500): past it a live search is refused before it is sent,
  with the message "live prices are rate-limited today, showing stored results", and
  `kiwiStats()` reports `budgetSpent` and `refusedToday`;
- retries on 503, 429 and a dropped reply (three, backing off); a 400/404 gets a fresh session
  and counts as an attempt (three, then an error), never an endless loop;
- a **circuit breaker**: the first 403 or 429 (on a search or on the initialize handshake)
  marks the address throttled for five minutes (`throttledUntil`, visible in `kiwiStats()`);
  every live search in that window throws the plain sentence "Kiwi is throttling searches
  from this address..." at once, without a request leaving the process, because hammering
  a throttled address only lengthens the block. Memo hits still answer. The chat shows the
  sentence as is;
- every itinerary seen goes to the fare memory (`lib/db.ts`) without slowing the answer.

Every feature states how many searches it makes (in its route comment) and bounds them. The
routes that can be made to search on demand (`/api/board`, `/api/wild`, `/api/plan`) honour
`fresh` only with the shared `ATLAS_FRESH_TOKEN`; a public URL reloaded ten times serves the
stored answer ten times. A run in which every search failed (a throttled address) is answered
with a note and not memoised, so "no deals" never outlives the throttle (`/api/finder`,
`/api/purpose`, `/api/combos`).

### 3. The engines (`lib/*.ts`, server only)

| Engine | What it does | Searches |
|---|---|---|
| `board.ts` | the cheapest return getaways from one airport over 45 days (or a month), 2 to 7 nights: nearby countries first, big cities in the wide countries, the home market's favourites | ~35, ~140 for a home-market airport (the favourites one by one) |
| `finder.ts` | a custom search over a period from several airports: must-include date, nights, direct, max hours (0 means no limit), a region or country, open-jaw home, hidden-city scan | ~20, 40 with open-jaw |
| `scan.ts` | the price calendar: cheapest per month to one destination, open-jaw optional, the fare memory asked first | 1 per month, 3 with open-jaw |
| `combos.ts` | two-city versions of a deal: fly in, train or coach to a neighbour, fly home | 6 |
| `wild.ts` + `wild-variants.ts` + `judge.ts` | the long loops: way in (via a cheaper hub when that wins), a chain of one-way hops and border crossings, way home, stopover, living costs, visas, a model's verdict; variants build 2 or 3 versions and rank them (3 up to 28 nights, 2 past that; a dated window has them too, since every version is keyed on the window) | 40 to 60 per version, about 65 worst case; at most about 200 from one click |
| `longstay.ts` | one to three months somewhere: the eight best bases of a region by worth for money, flight in and out through the scan, rent and living from World Bank price levels, side trips, climate, visa | up to 4 per base |
| `group.ts` | several people from different airports meeting somewhere: common windows, then the cheapest city for everyone | bounded per window and city |
| `purpose.ts` | events worth flying for in a window, each with the cheapest way there (boards first, then live) | `live` param, max 8 |
| `plan.ts` | the day-by-day plan of a wild trip, grounded in the Wikivoyage guides, Tavily research and Foursquare ratings, written by the model | 0 (model and research calls) |
| `insights.ts` | is this fare good: the typical price for a route and month from the fare memory | 0 |
| `climate.ts` | the best months for a city from NASA POWER normals | 0 |
| `agent-tools.ts` | every engine as a tool for the chat agent (AI SDK, Bedrock) | the engine's |

### 4. The routes (`app/api/*`)

Thin: validate (`lib/params.ts`), memo (`lib/memo.ts`), call the engine, set headers.
Three shapes:

- **JSON** (`deals`, `combos`, `events`, `eats`, `hotels`, `hotel-deals`, `purpose`,
  `scan`, `plan`, `fares`, `reach`, `place`, `sights`): one answer, `Cache-Control`
  with `max-age` and `stale-while-revalidate`, a `400` with a plain sentence for a bad
  parameter, a `502` for a failed upstream.
- **NDJSON streams** (`board`, `finder`, `wild`): one JSON object per line, `{start}`,
  `{deals}` or `{progress}` as they arrive, `{done}` or `{trip}` or `{error}` last. The
  stream is never silent for more than 15 seconds (`keepAlive` in `lib/memo.ts` sends a
  `{progress}` line), so proxies do not close it. A visitor who leaves mid-search does not
  abort it: the result is still stored.
- **The chat** (`chat`): AI SDK streaming with tool calls; the client renders tool results
  as cards and the globe listens.

Every memo is a `TtlLru` (bounded, 500 entries, a TTL per route). Identical requests in
flight share one promise (`InFlight`). `maxDuration` per route: 30 for the quick ones, 60
for one or six searches, 120 for a board or a finder run, 300 for a wild trip, a plan or
the chat (Vercel Fluid compute allows up to 300 on the current plan).

A wild trip's departure window is clipped, not refused: `to` becomes `from + 10 days` when
it is further out (the engine searches ten days at most), and `/api/plan` clips the same
way, so the plan is looked up under exactly the key the trip was stored with. Only `to`
before `from`, or a date that is not real, is a 400.

**The usage log.** The finder, wild, scan, longstay, group and live board routes call
`logSearch` from `lib/db.ts` after their engine answers: the kind, the parameters (never
personal data: no names, coordinates or labels), the number of results and the
milliseconds, into the `searches` table. Fire and forget: never awaited in the response
path, errors swallowed, a no-op without `DATABASE_URL`. A stored board or a memo hit logs
nothing; the log counts work done, not pages served.

### 5. Storage

**Vercel Blob** (`lib/boards-store.ts`, store `atlas-boards`, public read): everything that
is rebuilt and would bloat git. Paths: `boards/<GW>.json` and `boards/<GW>-<YYYY-MM>.json`
(146 nightly boards plus monthly ones, 4 MB in all), `wild/<key>.json` (built trips, a day),
`plan/<key>.json` (plans, three days), `hotels/snapshot-<date>.json`, `hotels/latest.json`
and `hotels/test-<date>.json` (limited or sandbox runs of the ingest, never read by the
site). Reads go through a ten-minute in-process cache; a write fills the cache. Only a real
404 from Blob is remembered as "missing" (a minute); any other failure serves the last copy
the instance saw (kept a day) and caches nothing, so a Blob hiccup never turns into a wave
of live rebuilds. A stored board counts as fresh for 26 hours (the nightly job runs at
01:00 UTC), and a live rebuild never replaces a richer stored board unless that board is
more than two days old. Without the token the site still runs, with the committed Romanian
`deals.json` as the fallback and no persistence.

**Postgres** (`lib/db.ts`, Supabase pooler, `DATABASE_URL`): the shared memory. Tables
created on first use: `fares` (every itinerary any search ever saw, with its time),
`hotel_prices` (the nightly hotel snapshot rows), `trips` (saved trips), `searches` (a
log). Every function is a no-op without the variable, so nothing depends on it; with it,
the scan skips months the memory already knows, insights can say "typical", and the hotel
deals have a history that survives Blob housekeeping. Three connections per instance,
`prepare: false` for the transaction pooler, TLS required. Every `date` column is read
through `to_char(..., 'YYYY-MM-DD')` and every timestamp through an ISO formatter, so
callers always get `2026-12-15` and `2026-10-10T12:37:20.011Z`, never a locale string
(the driver hands back JS Dates otherwise). `ensureSchema` retries once after a second
when the first connection of a cold instance drops, and forgets a failed attempt instead
of leaving the database switched off for the life of the process.

**The hotel window rollover.** The nightly snapshot prices one standard weekend: the
Friday to Sunday at least 28 days out. That Friday is the same for seven consecutive
nights and jumps to the next one every Saturday (the day `today + 28` lands on a Saturday).
A price for one weekend says nothing about another, so `lib/hotel-deals.ts` groups the
history by city **and check-in date** and compares tonight's snapshot only with the earlier
nights that priced the same Friday; three such snapshots (tonight's included) are the
minimum. In practice: the Saturday and Sunday snapshots of each week are "warming up"
and the deals show from Monday to Friday. The history is read from Postgres first (the
rows carry their check-in) and, without it, from Blob by the expected paths
`hotels/snapshot-<date>.json` for the 45 days before the latest snapshot, five reads at a
time, no listing (a night that was never written is one cheap 404, remembered a minute).
Sandbox snapshots and days with fewer than 40 cities (test runs) never enter a median.

**Browser**: the conversation and the visitor's preferences live in `localStorage`.

### 6. Jobs (`.github/workflows/refresh-data.yml`)

| Set | When (UTC) | What | Writes |
|---|---|---|---|
| daily | 03:15 | airports, Travelpayouts airports and airlines, countries (rates, advisories), holidays, weather | commit `public/data` |
| weekly | Monday 03:45 | GeoNames towns, GTFS ground graph, one-way fares | commit |
| monthly | 1st, 04:30 | heritage, visa, ferries, Overture places, GTFS, fame, costs, climate | commit |
| boards | nightly 01:00 | 150 airports × ~35 searches on 8 runners (own addresses), 15 min each | Blob |
| hotels | nightly after boards | `pnpm ingest:hotels`: 80 cities × 2 LiteAPI calls, the cheapest decent hotel for the Friday to Sunday four weeks out | Blob, Postgres |

A commit redeploys production (Vercel builds every push to `main`). The repository is
public, so Actions minutes are unlimited. Secrets on the repo: `BLOB_READ_WRITE_TOKEN`,
`LITEAPI_KEY`, `DATABASE_URL`.

### 7. The agent and the globe

The chat (`components/ChatPanel.tsx`, `app/api/chat/route.ts`) is the front door: a
persistent conversation that knows where the visitor is, their airports, passport and
month, and calls the engines as tools. Tool results come back as cards and widgets (date
pickers, region pickers), and the globe listens: the chat dispatches `atlas:pick` when it
needs a region, dates or a place picked on the map, the globe answers `atlas:picked`. The
panel's Trips tab (`components/TripsPanel.tsx`) draws any trip the same way (`RouteStrip`):
the loop as a strip of photos, the stops as cards, the legs as rows with booking links.

## Costs and limits

- **Kiwi**: free, no key, unpublished terms, a throttle per address after ~2,000 searches a
  day. The nightly boards are sharded over eight runners for that reason. On Vercel, each
  function instance has its own counter, budget and memo; the total across instances is
  unknown, so the live features stay bounded: one click is at most ~35 searches for a board
  (~140 for a home-market airport), ~40 for a finder run, about 65 for one wild trip and
  about 200 for three ranked versions, and each instance refuses live searches past 1,500 a
  day. `fresh` needs the shared token, so nobody can repeat those numbers on demand.
- **Bedrock** (the agent, the judge, the planner): about 3 to 5 cents a question, a plan
  about 20 cents; `ASK_MODEL` switches the model.
- **LiteAPI**: free lookups on the production key; 160 calls a night for the snapshot plus
  two per deal page view (memoised 30 minutes).
- **Foursquare**: 500 free Pro calls, then credits; two calls per city per day at most.
- **Tavily**: about 1,000 searches a month free; a plan uses about ten.
- **Vercel**: Hobby plan, Fluid compute; the long routes run up to 300 s. Blob is 4 MB.
- **Supabase**: free tier, 500 MB; the fares table grows by a few MB a month.
- **GitHub Actions**: unlimited on a public repository; the boards take 8 × 15 minutes a night.

## What scales and what does not

Scales without thought: the static data (one import per instance), the stored boards (a
Blob read per ten minutes per instance), everything memoised, the event feeds (cached three
hours), Postgres reads (indexed by route and date).

Scales with care: anything that calls Kiwi live. A hundred visitors asking for a hundred
different airports in one hour is 3,500 searches from Vercel's addresses, which Kiwi will
throttle. The mitigations are the nightly boards (the popular airports never search live),
the in-process memo, the shared in-flight promise, and the concurrency gate. The next step,
if traffic grows, is a shared memo (Postgres `fares` already holds every result; the scan
reads it first, the others could) and a queue so live searches are serialised per deploy.

Does not scale as built: the wild trip builder (minutes, 40 to 60 searches, one visitor at
a time per key), the day planner (a minute of model calls), the group trip (searches per
member per window). They are fine as "one person asks, everyone gets the stored answer",
which is how they are stored, and wrong as "everyone asks something different".

## The Kiwi dependency and the fallback

Kiwi's public search is the bridge, not the foundation: no key, no SLA, no published terms.
If it closes, the site keeps: every stored board (Blob) and every fare ever seen (Postgres)
as a history; Travelpayouts cached one-way fares (`lib/travelpayouts.ts`, the Explore and
Trips tabs already use them) as the next price source, with commission links; and the
affiliate programme as the way to a proper Kiwi Tequila API key. The engines take a
`searchFlight` with the same shape, so a replacement is one adapter in `lib/kiwi.ts`.

## Changed in round two (10 October, night)

- `lib/kiwi.ts`: the memo key is normalised; a 403 or 429 opens a five-minute breaker.
- `lib/db.ts`: ISO dates and timestamps from every query; `ensureSchema` retries once and
  forgets a failure; `logSearch` is called from six routes (above).
- `lib/hotel-deals.ts`: medians per city and check-in date; history by expected paths,
  Postgres first; the rollover documented above. `pnpm ingest:hotels` is the job's command.
- `/api/wild` and `/api/plan`: a dated window may have ranked versions (the engine keys
  each version on the window); a window wider than ten days is clipped, not refused.
- `/api/finder`: `maxHours=0` means no limit (it used to clamp to one hour).
- The other streams: the chat gained `hotel_deals`, `scan_cheapest`, `long_stay`,
  `group_trip`, `best_months`, `price_insight` and `stopover_programmes` as tools and a
  per-turn search budget; the Deals tab shows a hotel deals strip; the Trips tab holds the
  long stay and group forms as Globe state; the Globe sends `/api/plan` the full trip key;
  the ground graph gained Amtrak, KTM Malaysia and Thailand's intercity feed (next weekly
  run), with the GTFS ingest capped at 2 GB and two threads for DuckDB; the fame ingest
  refuses namesake articles (Glasgow, Montana) by distance.

## The route finder: the cheapest way from A to B (`lib/route-finder.ts`, `/api/route`)

One question, "how do I get from Brasov to Lisbon around the 14th for four nights", answered
by going through every way the data knows, inside a search budget. `cheapestWay(q)` returns a
`RouteResult`: the two places with their candidate airports, every `RouteOption` found (legs,
total, door-to-door hours, stops, a plain title, a why line, the booking urls, a score), the
`cheapest` and the `fastest`, what was `considered` in words, `searched`/`failed`, and
`sources`, a compact list of what fed the options: `live` (a Kiwi itinerary, from the main
search or a hub pair), `memory` (a remembered fare) and `ground` (the ground graph or the
road estimate gave a whole way). The chat names the source from that list, not from the
wording of the notes. A fly leg built from the fare memory carries `remembered: true` (dates
known, times not, `estimated` set); the estimated legs to and from an airport are part of
every option and are not a source of their own. The price on a card in the panel is
`total`, the whole trip, there and back for a return.

**The UI** (`components/RouteFinder.tsx`) sends a budget of 12 by default (`ROUTE_BUDGET`:
the main search and two or three hubs, two such clicks staying under Kiwi's burst throttle)
and 24 with "Search harder" (`ROUTE_BUDGET_HARDER`, the engine's own default). Since the memo
is keyed without the budget (below), "Search harder" on a question just answered streams the
stored options at once and spends only on the hubs the first click left out.

**Places.** `from` and `to` take a city name, an airport code, a place name or `lat,lon`:
`cities.json` first (accents folded, so "Brașov" and "brasov" are one), then the airports
file (an airport's city or name), then the GeoNames towns; a name none of them knows goes to
Kiwi as the `flyFrom`/`flyTo` of the main search and the landing airports place it. A
three-letter word is a code only when typed in upper case ("BAR" is the airport in Qionghai);
typed as a name ("Bar") the places are tried first and the code is the fallback, so "otp"
still finds Bucharest. The two ends of a `RouteResult` always carry finite coordinates: a
side that could not be placed has `placed: false`, no airports, and borrows the other end's
point, so a globe that frames the two ends still lands somewhere sensible.

**Candidate airports** per side (`gatewaysFor`, at most four): the nearest large and medium
airports by drive time, ranked the way a home is ranked (`nearestGateways`, big airports
discounted), plus any airport a train or coach reaches within three hours by the ground
graph (`reachFrom`, the graph's minutes plus the hop from the station); the code the
traveller typed always comes first. Brasov gives `GHV, BCM, OTP (train), BBU (train)`. A
place with nothing medium or large in reach (Arctic Bay, Nain) gets its own small airport
within 150 km, so the search is by code and the landings map back. An airport in reach of
both ends (Valencia's VLC by train from Madrid) is kept on the side it is nearer to, or the
main search would ask Kiwi for a flight from an airport to itself.

**The window** is `depart` plus or minus `flex`, never starting in the past: a departure
within `flex` days of today is trimmed to start today (Kiwi answers nothing for a day gone
by, and that empty answer would have been kept for an hour); a progress line says so.

**The searches, in order, all under `budget` (default 24, the route caps it at 40; 0 means
the fare memory and the ground graph only) and a deadline (`deadlineMs`, default 90 s):**

1. the fare memory (`rememberedFare` over every airport pair in the window), an option at
   zero cost, marked "a fare seen this week";
2. **one** Kiwi search with all origin airports as `flyFrom` and all destination airports as
   `flyTo`, the window out and the window plus `nights` back. Its fifteen itineraries are
   classified by the airport used on each side: `direct` (the nearest airport on both sides,
   not a nonstop promise: `nonstop` is the flag for that and the title says "(1 stop)"),
   `nearby-airports`, `ground-then-fly` (the origin airport is reached by train or coach),
   `fly-then-ground`, `open-jaw` (the return uses another airport on either side). The ground
   legs to and from the traveller's points are added as legs, priced at 0.10 euro per km and
   marked `estimated`, their minutes from the graph or the drive estimate;
3. `via-hub`: up to four hubs between the points (the origin board's cheapest big cities
   within a 60 percent detour first, then the biggest hubs within a 35 percent detour of the
   great circle, each at least 150 km from both ends), two one-way searches each (A airports
   to the hub over the window, the hub to B airports the same day or the next), the cheapest
   pairing with at least two hours to change. For a return the way back is searched **after**
   the outbound pair is chosen, in a window `nights` plus or minus `flex` after the day it
   leaves and never before it has arrived, and the pair must make between `nights - flex`
   and `nights + flex` nights, the same rule the main search is filtered by (a 2-night
   question cannot come back as a 9-night trip or a return that leaves before the arrival).
   Door-to-door hours are the two flight durations plus the wait at the hub (one clock) plus
   the ground legs, so a time-zone change never adds or removes hours. A hub in a "been"
   country is a same-day connection only. No hub search is issued once Kiwi's breaker is
   open or the deadline has passed. **A change of airport at the hub:** Kiwi answers a city
   code with any of its airports, so the first ticket may land at Treviso and the second
   leave from Marco Polo (OTP to TSF, VCE to LIS), or Beauvais then Charles de Gaulle. When
   the two airports are both in the data and within 150 km of each other (`airportChange`),
   the pair gets a ground leg between them: kind `road`, minutes from `driveMinutes` of the
   straight line, price at the engine's 0.10 euro per km (floor 3), `estimated: true`, note
   "change of airport, about N km by road". Its price is in `total` (and in `backTotal` for
   the way back) and counts when the cheapest pairing is chosen, so a 95 euro ticket into
   Beauvais loses to a 100 euro one into Charles de Gaulle once the road is added; the hub
   wait must cover the road plus the two hours; the title says "(change of airport)" and the
   second ticket's note gives the road minutes and the wait left. Hours stay flights plus the
   wait at the hub, which already contains the road, so its minutes are not counted twice.
   Two airports the data cannot join (unknown, or farther apart than one hub) are never
   paired: the two tickets must then use one airport. The same rule applies to the back pair;
4. `ground-only` when the points are within 1,500 km: Dijkstra over the graph to the
   stations within 25 km of the destination, up to twelve hours, zero searches; the road
   estimate stands in under 300 km when the graph has no path (a border the feeds do not
   cross, Iasi to Chisinau).

Two places within 150 km are a ground trip: no flight is searched (Brasov to Bucharest is
the train, 0 searches). Past that the flight is always searched, even when the ends reach
the same airport: Madrid to Valencia (302 km) is the 2.3 h train **and** the 43 euro nonstop.
`score = total + hours x 6` (euros per hour, the balanced tradeoff) orders the options;
`cheapest` is the lowest total and `fastest` the fewest door-to-door hours (check-in and
landing time included). `total` is the whole trip there and back; `backTotal` is the way
back's share of it (never to be added on top), left out when the return is on the same ticket
as the outbound, since that ticket cannot be split.

**Time.** Each live search is raced against a 35 s cap (Kiwi's own retry ladder can hold a
request past two minutes); a search that runs over is counted as failed and not waited for,
but it goes on inside the gate and lands in Kiwi's memo for the next caller. Past the 90 s
deadline no new search is issued and what was found is returned with a note ("Kiwi was slow
today ... ask again in a minute"), so the `{done}` line always arrives inside the route's
`maxDuration` of 120 and the chat tool never reports an interrupted turn for this engine.
The throttling line is said once per run, not once per refused search.

**The memo.** The engine memoises a finished answer for an hour (`TtlLru`, 300) by the two
places as the data resolves them (coordinates to three decimals plus the code the traveller
typed, so "BAR" the airport and "Bar" the town, or "41.9,12.5" and "-41.9,12.5", never share
an entry; a name no data knows is keyed by its text as typed), `depart` (the default of three
weeks out filled in, so a question without a date is keyed by the day it means), `flex`,
`nights` (0 for a one-way ask, whatever nights box came with it), `oneWay`, `maxHours` and
`exclude`, never by the budget. The budget is a ceiling on what the whole answer may have
spent: a stored answer that was run with at least the budget asked, or that is complete (no
search failed or refused, no hub left out for the budget, the deadline or the breaker), is
served as is, whatever budget comes with the new ask (a budget of 0 after a budget of 12
gets the twelve-search answer). A stored answer that was cut short by a smaller budget is
extended, not discarded: the run resumes from the stored stage (the placed ends, the window
searched, the hubs picked and which were done, every option found, the sources, the
searches spent), streams the stored options first and tries only the hubs not yet searched,
with the earlier searches counting against the new ceiling (`searched` is cumulative; a
considered line says "extended: 3 searches kept from the answer of 1 min ago, 4 made now").
A run that stopped for time (the 90 s deadline left hubs unsearched) is stored with the
searches it actually spent as its ceiling, not the budget it was allowed, so the same budget
asked again a minute later resumes from the stage, as its note ("ask again in a minute for
the rest") promises. A run that never reached the main search (budget 0, or a place Kiwi
could not place) leaves no stage, so a bigger budget later runs it all. Identical runs in
flight are shared (`InFlight`, keyed with the budget), the run logs to `searches` as `route`
(codes and numbers only, `extended` flagged) and a run in which any live search failed
(throttled or timed out) or was refused by the open breaker (a search the breaker held back
counts as `refused`, not as skipped for the budget; the note then says Kiwi is throttling
and to try again in a few minutes, not to change the dates) is never stored, nor does a
failed extension replace the stored answer, so a partial answer never becomes the answer
for an hour; Kiwi's memo makes the searches that did answer free the second time. The
window trim ("The window starts today (...), not (...)") is a considered line as well as a
progress line, so the chat can quote it. `GET /api/route` streams NDJSON:
`{progress}` lines, an `{option}` per way as it is found, and `{done: RouteResult}` last,
with `keepAlive` and `maxDuration` 120; bad input is a 400 in the shared `{error}` shape.
Brasov to Lisbon with `budget=5` (the main search and one hub return) is about ten seconds.

**The finder's exhaustive mode.** `findDeals` takes `exhaustive` (default false) and
`origin: {lat, lon}`: the origins grow with the airports a train or coach reaches within
three hours of the point (`airportsByGround`), and after the targets every origin airport
gets its own search of **the same question**: "anywhere" when nothing was named, or the named
targets as one comma list (a region's nearest four countries, a listed country), because a
multi-origin search answers only from the cheapest airport. A named search also gates the
landings: a deal from a search for Italy must land in Italy, whether it came from the main
loop or a per-origin one. At most five origins, so at most five extra searches; the header of
`lib/finder.ts` states the bound (44 worst case) and the response shape is unchanged. The
`/api/finder` route does not read `exhaustive` yet (only the chat reaches it); see the
handoff in the round-three report.

## Engine rules settled in round three (the other engines)

- **Deadlines.** `buildWild`, `longStay` and `groupTrip` take `deadline` (epoch ms,
  `WildParams.deadline`, `LongStayParams.deadline`, `GroupParams.deadline`), so a caller with
  a time cap (the chat's turn) gets an answer instead of nothing. Past it the wild chain
  stops growing and the way home is searched from the stops found so far (the way in and the
  way home are never skipped; the stopover refinement is), the long stay leaves the bases
  still queued unpriced and the group the windows left, each with `partial: true` and a
  plain note ("not priced in time; ask again"). An answer cut short is not memoised, so the
  next ask prices what is missing. The route finder's own cap is `deadlineMs` (above).
- **Wild with countries is custom.** A `countries` list replaces the region's list whatever
  region was named (`effectiveRegion` is `custom`): the trip is labelled by its countries,
  tagged on the globe by them and keyed as custom (`customKey`, whose tenth argument holds
  the extra constraints). Region `custom` without a list is refused. `buildWildVariants`
  keeps the variants' refusals (a must city on the been list, too few nights, every way in
  over the hours cap) and, when no variant builds, rethrows the first one instead of the
  generic "no way into that region".
- **Long stay: cities as the bases.** `mustInclude` (city names or codes, up to eight;
  `cities` is the alias the form sends to `/api/longstay`) makes the named cities the only
  bases, whatever their fame or the region, and their countries join the country list; a
  country with none of the named cities is reported as skipped.
- **Trips: the bounded walk.** `lib/trips.ts` walks the ground graph with Dijkstra passes
  that are synchronous and cost in proportion to the ground limit (about 80 ms at twelve
  hours). One request may run at most 150 passes up to four hours, shrinking to 50 at twelve
  (floor 40), about four seconds of walking; past that a city is not walked further and the
  trips found stand. Chains are walked cheapest entry first, so the cut falls on the dearest
  ways out. Reaches are memoised across requests (64, 30 minutes), so a repeat walks nothing.
- **Purpose: how a filter matches an event.** `eventMatches` takes free words: an event's
  kind (festival, sport, culture, season, music, food), a word of its name or city (whole
  words; four letters or more also as a prefix, so "lantern" finds "lanterns"), a two-letter
  token as a country code and nothing else ("ro" is never a piece of "Roskilde"), a
  three-letter token as a city code or a word; a phrase must have every word in the event;
  the note is never searched, it is description, not a tag.
- **Group: the budget is applied after the memo.** `budgetPerPerson` is a filter on the
  options, not a search parameter: it stays out of the memo key, the unfiltered result is
  what is stored, and the cap is applied on the way out (`dropped` and a line saying so), so
  nudging the budget box costs no searches.

## Rules that keep it honest

No price is invented: every euro on the site is a Kiwi itinerary, a LiteAPI rate, a
Travelpayouts cached fare or an estimate labelled as one (ground legs, living costs). Every
source is named in the manifest and on the globe. Nothing is scraped from Google, Booking,
Yelp or Tripadvisor; LiteAPI is the only hotel source and Foursquare the only ratings source,
and "MCP" in this codebase means these keyed tool servers, nothing more. Secrets live in
`.env.local`, Vercel and GitHub secrets, never in the repository.

## Been: countries already visited (optional)

The visitor can mark the countries they have been to and ask for only new ones
(`docs/plans/been-feature.md`). The list lives in the browser; on the server it is one query
parameter, `exclude=RO,HU` (ISO2, parsed with `parseExclude` from `lib/been.ts`, bad entries
dropped), on every search route: `finder`, `scan`, `combos`, `purpose`, `longstay`, `group`
(JSON body, array or comma string), `wild` and `plan`. It is part of every memo key, never of
the usage log (only the count of excluded countries is logged), never stored.

The rule is the same everywhere: a destination or an overnight stop in an excluded country is
never proposed, a connection or layover through one is always fine. Each engine takes
`exclude?: string[]`:

- `finder.ts` drops excluded targets before searching (`allowedTargets`, with
  `targetCountry` resolving country names, ISO2 codes, city names such as "Milan" through
  `cities.json`, and city or airport codes; a board label that is really a city name, the
  boards call VA "Rome", is ignored so "Rome" means Italy) and drops "anywhere" landings in
  one; a run left with no target answers `searched: 0` and a `note`. The filter runs before
  the region or nearby list is cut to 18 (and before the typed list is cut to 4), so a
  well-travelled visitor gets the next unvisited countries, not a shorter list. Hidden-city
  tricks never get off in an excluded country, and a trick deal carries the via city's
  country, where the traveller gets off. The home country keeps its own rule.
- `scan.ts` answers a destination in an excluded country with a `note` and no search (a city
  name or airport code resolves to its country too); live and remembered fares landing in one
  are dropped; an open-jaw home leg from an excluded country is not priced.
- `combos.ts` answers a deal whose own destination is in an excluded country with `note` and
  no search (the route does not memoise it), and leaves out neighbours in excluded countries
  before searching (the traveller would sleep there); `findCombos` takes the positional
  arguments or one object.
- `purpose.ts` hides events in excluded countries before any board lookup or search.
- `longstay.ts` drops those countries from the candidate bases and lists them under `skipped`.
- `group.ts` filters the nearest countries and a region's list before cutting them to two or
  three, passes the list to the finder, answers a fully excluded region with a 400 (a
  `GroupInputError`), and keeps a member's home city as a host option only when its country
  is allowed for the others.
- `wild.ts` never makes an excluded country a stop or a landing; a hub there is still fine as
  positioning (same-day connection only, no night before the long-haul) and the optional
  stopover night on the way home skips such hubs. A region with every country excluded is a
  400 before any search. The stored trip key gains `x` plus a six-character stable hash of
  the sorted list (`excludeToken`, appended after the 60-character cut so it is never lost);
  `wild-variants.ts`, `/api/wild` and `/api/plan` build the same key, so an excluded build
  never collides with a plain one and a plain key is unchanged.
