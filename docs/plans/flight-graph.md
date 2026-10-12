# The flight graph: Dijkstra on price

Patrick, 2026-10-12: "money is more important than hours; why does ground have Dijkstra, when
flights should have had it with price as the edge; that was the most important".

## Why the flights are not a graph today

Dijkstra needs the edges before it starts. The ground graph has them: 400,000 timetable links
on disk, so a search from any point takes milliseconds. Flight prices exist only when Kiwi is
asked: one search per airport and date range returns its 15 cheapest itineraries, and Kiwi
throttles an address after about 2,000 searches a day. The graph walk (lib/graph-walk.ts)
therefore expands places in Dijkstra's order (cheapest so far first) but asks Kiwi for each
place's edges lazily and keeps only a beam of 2 or 3 states per depth, which is why it can
miss loops a full search would find.

## The plan

1. **A nightly flight graph** (`scripts/ingest/flight-edges.ts`, a new sharded job in
   `.github/workflows/refresh-data.yml` beside the boards): for about 150 airports (the
   boards' `popularGateways` plus every airport of the travellers' home countries seen in
   the usage log), one one-way search `flyFrom: airport, flyTo: anywhere` per 3-day bucket
   for the next 42 days: 14 searches an airport, 2,296 a night for 164 airports across 8
   runners. Each itinerary is an edge: from airport, to airport, day, price, minutes, stops,
   carrier, url, seen, plus the local departure time and the arrival day (an overnight flight
   must not give its first stop a night it never has). Stored in Blob as
   `graph/flights/<date>/shard-<i>.json` (column arrays) with `graph/flights/latest.json`
   naming the shards, and merged with the fare memory's one-way rows of the last 3 days.
2. **`lib/flight-graph.ts`**: a time-expanded graph. A node is (city, day). Edges: a flight
   (price), a night in the same city (0 euro, or the city's living cost when the question
   asks for the whole trip's cost), a train or coach from the ground graph (estimated price,
   same day). `cheapestTrips(query)` is Dijkstra on euros with hours as a tie
   breaker only (the default tradeoff is price; Trip style can switch it), honouring nights
   per place (a stay edge must be taken between `min` and `max` times in a city before
   leaving), the Been and avoid lists, and the traveller's home airports (any airport of the
   home country, with the ground leg to the door).
3. **Loops**: a label-setting search (Dijkstra with labels per (city, day, places visited
   count)) finds the cheapest closed loops of 1 to N places within the window; the top ten
   are re-priced live (a handful of searches) before they are shown, and the fare memory is
   updated with what the live check saw.
4. **Everywhere on a date** reads the same graph: depart on a day (or a 3-day window), every
   reachable city with its cheapest one-way, and with a return date the cheapest way home
   from it (to any home airport), grouped by country; live searches only to confirm.
5. The walk, Smart loop, Wild, the custom search and the chat's tools ask the graph first and
   Kiwi only to confirm or to fill gaps.

## Bounds

- Nightly: 2,296 searches across 8 runner addresses (about 290 each), under each address's limit.
- Per question: zero searches for the graph search itself, up to 10 to confirm the winners.
- Prices in the graph are up to a day old and marked with when they were seen; the confirm
  step shows the live price before booking.

## Status (2026-10-12)

Built: steps 1, 2, 4 and the graph half of 3. Not built yet: the live re-price of the winners
(step 3's last sentence) and step 5 (the callers: the walk, Smart loop, Wild, the custom search and the chat still ask Kiwi directly).

- **`scripts/ingest/flight-edges.ts`** (`pnpm ingest:flight-edges`). `FLIGHT_SHARD=i/n` like the
  boards. The airports are every Romanian airport (OTP, BBU, CLJ, IAS, TSR, SBZ, GHV, CND, CRA,
  BCM, SCV, SUJ, OMR, TGM, BAY: the only home country in the usage log so far) and then
  `popularGateways(150)`, a city skipped when all its airports are already in the home list:
  164 in all. Three searches at a time through `searchFlight`'s gate; a shard stops after 8
  failures in a row and keeps what it found. Each shard writes its file, then merges itself into
  `latest.json` (read, add, write, read back and retry; the day's folder is listed too, so a
  shard lost to two runners writing at once is still named). Only `FLIGHT_PRODUCTION=1` (set by
  the workflow alone) with none of the test knobs writes under `graph/flights/<date>/`; any other
  run (`FLIGHT_LIMIT`, `FLIGHT_AIRPORTS`, `FLIGHT_DAYS`, `FLIGHT_BUCKET`, `FLIGHT_FROM`, or no
  production flag) writes only under `graph/flights/test-<date>/`, so a laptop run can never
  overwrite a night's shard. Shard 0 of the nightly run deletes the day folders older than the
  manifest keeps (3 days), looking a week back, so Blob does not grow by a night every night.
- **`lib/flight-graph.ts`**. `loadFlightGraph()` reads the manifest's shards (plus any shard of
  the newest day the manifest missed; with no manifest, the dated folders of the last 4 days by
  name, newest first, never the whole root and never a test folder), adds the fare memory's
  one-way rows of the last 3 days (own pool, 2 connections, nothing without `DATABASE_URL`):
  per airport pair and day the cheapest of the newest sighting (rows within 12 hours of the
  newest, so one search's answers count together), not the cheapest of three days, so a fare
  that has risen is not shown at its old low. Merging the two, sightings more than 12 hours
  apart go to the newer; within one night the cheapest wins, on a tie the nightly edge (it knows
  the time). Indexed by (from city, day). Cached 10 minutes per root, 1 minute when the load was
  thin (no manifest, no shard, or a shard unread); `FLIGHT_GRAPH_PREFIX` points it at a test root.
  `cheapestTrips(q)` is the label-setting search: a label is (arrived in or leaving a city, day,
  places so far, first day). At each such node one label is kept per sequence of cities (the
  same cities in the same order have the same futures, so the cheaper wins) and up to 6 different
  sequences side by side, so three London airports cannot crowd a cheaper trip through Paris out
  of a node. A stay is lo to hi nights in one edge; never the same city twice, never the home
  country, Been, avoid or a travel warning as a stop; it closes on a flight into a home airport
  (nights counted to the landing day, so an overnight flight home never makes the trip longer
  than `maxNights`), or a train or coach to the door or to a home airport's city, with the nights
  in range. It stops once the cheapest open label costs more than the tenth distinct trip
  (distinct = a different sequence of cities). Hard stops: 120,000 labels explored, 300,000
  made, or 4 s; hitting one sets `truncated` and a note ("the cheapest it found, not proven the
  cheapest"). Labels keep a flight edge's index or the shared ground link, never a built leg,
  and the legs are built for the ten winners only. A question whose places cannot fill the
  nights (`maxPlaces * hi < minNights`) answers at once with a note. Trade-off price counts
  euros only (minutes break ties), balanced adds 6 euro an hour, comfort 18. Home airports
  default to every airport of the home country within 6 h of the door on the ground graph, the
  leg priced at 0.10 euro per km. `everywhere(q)` answers every city with a flight from a home
  airport on the day (plus or minus `flex`), and with `back` the cheapest way home to any home
  airport, directly or through a neighbour up to 4 h away by land, grouped by country. The way
  out and the way home are chosen as a pair: the way home leaves at least a night after the way
  out lands (with flex they used to be picked apart, and a flight home could leave before the
  flight out). A city with no such pair is listed with its cheapest way out and no way home.
- **`GET /api/graph?mode=trips|everywhere`**: the two searches over HTTP, 400s in the shared
  `{error}` shape, a 10-minute memo, `maxDuration` 60. Trips refuses a window over 35 days and
  more than 5 places (the default is `ceil(maxNights / lowest nights)`, capped at 5), and a
  question whose places cannot fill its nights.
- **The workflow**: a `flight-edges` job in `refresh-data.yml`, 8 shards on the nightly cron
  beside the boards (no `needs`: each runner has its own address), `FLIGHT_PRODUCTION: "1"` in
  its env, and `flights` in the dispatch options.

Measured on 12 October 2026 with a test graph of OTP and GHV only (8 live searches, 20 to 31
October; 102 edges in 12,867 bytes, so a full night is about 29,000 edges and 3.7 MB) plus
4,159 fare-memory rows: the load took 0.9 to 1.3 s (mostly the database), the owner's case
(Brasov, 20 to 30 October, 5 to 6 nights, 2 to 3 a place, up to 3 places, price) took 2.2 to
3.0 s cold (the ground reaches, each a Dijkstra over 16,000 stations, memoised for an hour)
and 63 to 75 ms warm, exploring 6,300 labels; Everywhere took 58 to 78 ms cold and 1 ms warm.
The cheapest trip it found was 80 euro: Ghimbav to Budapest (24 euro, the nightly graph),
3 nights, a coach to Debrecen, 2 nights, a coach to Cluj and home by land.

After the review fixes (same day, the test graph plus a CLJ shard of 4 live searches, 4,284
edges): the owner's case took 2.2 s cold and 55 ms warm, exploring 7,961 labels, the same 80
euro trip first. The widest question the route used to accept (14 to 30 nights over 37 days,
1 to 3 a place, 8 places) had run 8.1 s and 664 MB without a note; it now stops at the label
cap in 1.3 s with `truncated` set, and runs under a 256 MB heap limit. Everywhere with `flex`
2 answered 61 cities in 127 ms, none with a way home before a night there. The fare-memory
change moves 60 of 4,236 airport-pair days, where the newest night is on average 11.3% dearer
than the three-day low.

Known gap: the Blob CDN caches every stored JSON for 10 minutes (`writeJson`'s
`cacheControlMaxAge: 600`, and a query string does not bypass it), so the ingest's manifest
read-back sees the copy from before its own write and retries for nothing, and a reader right
after the nightly run can read yesterday's manifest for up to 10 minutes. Correctness rests on
the day-folder listing (in the merge and in the reader), which is not cached.
