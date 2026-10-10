# The graph walk: searching trips the way a person does

Patrick, 2026-10-10 evening, after reading a chat that priced seven legs one by one: "how I do
it manually is use the Skyscanner explore from that location and I get the cheapest locations;
I think the graph should work like this 100%: get the cheapest ones based on edges; do we have
a Dijkstra or something". He would have done Brașov to Warsaw by plane, Warsaw to Gdańsk by
train, Gdańsk to another city, then back to Brașov, Sibiu or Otopeni.

## What exists

- Kiwi's search answers "anywhere" from one origin for a date range with the 15 cheapest
  one-way itineraries: that is Skyscanner Explore, one call.
- `lib/ground.ts` has a Dijkstra over 16,000 stations (time, not money).
- The fare memory (`lib/db.ts`, `lib/insights.ts rememberedFare`) holds every itinerary any
  search saw; the nightly boards hold a return fare per country from 146 airports.
- `lib/wild.ts` chains greedily by country; `lib/trips.ts` builds short loops from a one-way
  fare file; `lib/route-finder.ts` works one pair. None of them walks a graph.

## The engine: `lib/graph-walk.ts` (built 2026-10-10)

`walkTrips(params): Promise<WalkResult>`. Best-first search with lazy edges and a beam.

- **State**: city code (`HOME` for the traveller's door), the day they arrived, depth, the
  cities and countries visited, the legs and stops so far, money, hours, worth, and `cost`
  (money plus hours at the tradeoff's euro per hour minus the worth taken off) plus a
  heuristic for the way home: the cheapest one-way into a home airport the fare memory saw
  from that city in the last day, else half of tonight's board return fare to it, else a
  cheap one-way by distance (20 euro plus 0.04 per km). A state that cannot still pass
  through every must city in the depth left never joins the frontier.
- **Edges from a state**:
  1. Flights: the fare memory first (every one-way fare anyone saw in the last day out of the
     city's airports in the hop window; its own read in `graph-walk.ts`, since `lib/db.ts`
     has no "everything from X" reader), then the live "anywhere" search merged on top, the
     cheaper fare per city winning. From home the explore is always asked when the budget
     allows: it is the one question the walk is built on, and one search. From a stop it is
     skipped only when the memory already holds fifteen or more destinations, the size of a
     Kiwi "anywhere" answer, because what the memory holds is whatever other features
     searched (a pair, a country), not the cheapest places overall. The hop window: from home
     any day that still leaves `minNights` inside the asked window (Explore covers the whole
     range in one call), from a stop the stop's nights (`date + n .. date + n + 1`, or
     `date + a .. date + b` for a range), never so late that the next stop and the way home
     fall outside the window. From home only, when neither memory nor live gave a fare, the
     boards' return deals leaving in the window stand in at half the return price, marked
     estimated with source `boards`. Only boards of the traveller's own gateways count:
     `dealsFor` falls back to the committed Romanian file for an airport with no stored
     board, and a deal out of Bucharest is no way out of an Osijek door.
  2. Ground: `reachFrom` within `maxGroundMin` (default 5.5 h: Warsaw to Gdańsk is 310
     minutes in the graph), stations mapped to cities as `lib/trips.ts` does, leaving on the
     stop's last day, priced at 0.10 euro per km of straight line, marked estimated. Ranked by
     edge cost (price plus hours at the rate minus the city's bonus), not by minutes, and cut
     to eight; a must city is kept whatever its rank. A ground hop may stay in the country
     the traveller is in (Warsaw to Gdańsk); a flight never lands in a country already visited.
  3. Home: only when every must city is behind and the stop has had its nights, and not more
     than asked: the home window is `[max(date + nMin, start + minNights), min(date + nMax
     (+1 when fixed), start + maxNights, to)]`, so the last stop never swallows the rest of
     the trip; a loop that needs more nights goes one stop deeper, and a question whose stops
     cannot fill `minNights` (one stop of 2 nights for 5) is a plain note before any search.
     The fare memory is read per origin airport and departure day (not the cheapest of the
     month, which would shadow the one that fits), and the cheapest remembered way home
     inside the state's own window is used instead of a search. Otherwise one search
     `flyFrom: city, flyTo: <all home airports>` over that window. Alongside the flight, a
     train or coach to the door when the ground graph reaches the city from it (Sofia, Varna
     or Debrecen for a Brașov door at 12 h), priced like every ground leg and estimated. A
     road leg to and from the airport (0.10 euro per km, estimated) is added when the home
     airport is over 35 km from the traveller's point.
- **Cost of an edge**: price + hours x euro-per-hour (`HOUR_VALUE` from `lib/wild.ts`: way in,
  hop, way home; flights carry 90 minutes of airport time) + a stops penalty, minus half the
  worth of the city: fame and listings and hub size as `lib/wild.ts` scores them, +15 for a
  new country, +25 for a non-hub after a hub, +40 for a preferred country, +150 for a must
  city, and the style words' tilt (`wishTilt`). Been countries, avoided countries and cities,
  countries under a full travel warning and the home country are never a stop.
- **Allowed countries** (Wild's region): stops keep to them from depth 2; the way in may land
  in a hub (60+ destinations) outside them, so a cheap far-away entry through a hub stays
  possible.
- **Beam**: depth by depth. Every open state of a depth is sorted by cost plus heuristic and
  the best `beam` are expanded (default 3), depth up to `maxStops` (default 3). Depth by
  depth rather than one global queue, so a cheap deep branch cannot take the slots of a
  sibling that was not looked at yet. Searches worst case: 1 + beam x maxStops for the
  "anywhere" hops plus one home search per expanded state that can go home; 10 for the
  owner's case (beam 2, 3 stops).
- **Stops**: at the budget (no more live searches; the walk finishes from memory and ground),
  at the deadline (default 90 s, one search never held longer than 35 s), when the caller's
  `signal` aborts (the route passes the request's; a closed tab spends no more searches), or
  when as many loops as the beam have closed and the best open state of the next depth cannot
  beat the beam-th best loop even with the largest bonus every remaining stop could still
  take off (a child can be cheaper than its parent, so the bound subtracts it).
- **Output**: loops ranked by `score` (the closing state's cost plus the home leg at the way
  home's rate), deduplicated by their city sequence, at most six; each with legs (flight with
  booking url and times, train or coach with minutes), stops with nights and worth, `why`
  lines in plain words, and `searched`, `failed`, `fromMemory`, `expanded`, `considered`.
  `home` is the airport the loop flies out of, else the one it flies back into, else `HOME`;
  the "N minutes from you" line is written only when the first flight leaves a home airport,
  a coach from the door is named "as the way out". A bad place is a plain `note` with no
  loops, never a throw. `partial` is set when the breaker refused searches, when one of the
  run's own searches tripped it, when the deadline cut the run, or when the caller left.
- **Streaming** (`onEvent`): `node` when a state is expanded, `edge` for every edge found
  (the edge that led to an expanded state comes again with `chosen: true`), `loop` when a
  loop closes, `progress` lines. A way home is an `edge` with `to: "HOME"`, `home: true` and
  the home airport's (or the door's) lat/lon, so a globe keyed on city codes can draw and
  label it.

## The route: `GET /api/walk`

`g=GHV,SBZ,OTP&home=RO&lat=45.657&lon=25.601&label=Brasov&from=2026-10-20&to=2026-10-30&minNights=5&maxNights=6`
plus `nightsPerStop` (2 or 2-3), `maxStops`, `beam`, `budget` (default 12, cap 30),
`ground` (minutes, default 330), `tradeoff`, `exclude` (Been, ISO2), `mustInclude`, `avoid` (countries or
cities, codes or names), `prefer`, `countries` (allowed), `style`. Validated with
`lib/params.ts`; a bad value is a 400 `{error}`. NDJSON lines `{node}`, `{edge}`, `{loop}`,
`{progress}` and a final `{done: WalkResult}`, kept alive every 15 s, `maxDuration` 120. An
answer is kept for an hour per normalised question and served as one `{done}` line; two
callers asking the same thing share one walk (the second gets only the done line). A walk
the breaker refused or tripped, the deadline or the caller cut, or whose searches all failed,
is not kept. `logSearch("walk", ...)`,
fire and forget, codes and numbers only.

## Where it is used (to wire)

- A chat tool `walk_trips` ("find me a loop from here, 6 days, 2 days a city, not Germany"):
  call `walkTrips` with the visitor's gateways, point and label, `avoid` for the "not X" words,
  `mustInclude` for named cities; read `loops[].why` and `note`.
- Wild loops: `allowedCountries` = the region's countries, `maxStops` up to 6, `tradeoff`.
- Short loops: `maxGroundMin` 5 to 12 h, `maxStops` 2 to 3, tradeoff `price`.
- The globe: while a walk runs, every `{edge}` is a faint arc from the expanded node (`from` is
  a city code or `HOME`; `lat`/`lon` are the far end), the `{node}` lines pulse, a `chosen`
  edge brightens, a `{loop}` draws the closed loop; the panel shows the beam as a tree (city,
  cost so far, date).

## Bounds and honesty

- A walk never spends more than its budget; when the gate refuses, it finishes from memory
  and says so in the note, and the route does not keep that answer.
- Estimated prices (ground legs, the road to the airport, a board's half return) carry
  `estimated: true`; flight prices are live Kiwi itineraries or fares seen in the last day,
  with the source on every leg.
- Edges are one-way fares; a cheap one-way out of a city is only useful if the next hop and
  the way home are cheap too, which is exactly what the search optimises.

## Tested 2026-10-10 (20 searches through the gate, 19 reached Kiwi)

The owner's case (beam 2, 3 stops, 2 nights a stop, 5 to 6 nights, 20 to 30 October) closed
Warsaw → Milan at 96 euro (GHV to WAW 35, WMI to BGY 21, BGY to OTP 27, drive home 13),
Tirana at 119, Warsaw → Venice at 137, Warsaw at 143, with 86 edges streamed and 6 live
searches; the first run before the fare memory held these dates spent 10. The same URL again
answered one `done` line in 87 ms. `avoid=DE&exclude=HU` produced no German or Hungarian
stop or edge. A bad date, a past date, a window shorter than minNights, an unknown must city
and a missing `g` each answered a 400 sentence. `budget=0` closed the same 96-euro loop from
the fare memory alone, 0 searches, 7 states expanded.

## Review fixes 2026-10-10, later (5 searches reached Kiwi)

After the review: boards of other airports no longer stand in (Osijek at budget 0 says
"boards: none for OSI" and streams no edge); the way home is read per departure day; ground
hops are ranked by cost and a must city is always kept (Warsaw → Gdańsk is chosen at depth 2
with `mustInclude=Gdansk`); the explore always runs from home; a stop never takes more than
its nights (one stop of 2 nights for 5 is a note before any search); home legs stream as
`to: HOME, home: true`; a coach from the door is the way out, not "N minutes from you"; a
ground way home is offered; a throttled search marks the answer partial; the route's abort
signal stops the spend; the first hop may leave on any day that keeps `minNights` inside the
window. The owner's case at `budget=5` closed Naples → Rome at 123 euro (GHV to NAP 17,
coach to Rome, FCO to OTP 74) with 5 searches, all reaching Kiwi; the same URL again was one
`done` line in 106 ms; `budget=2, beam=3` closed the same loop from the remembered way home
(2 gate searches, 0 reached Kiwi, `fromMemory 1`). The Warsaw → Milan loop of the morning no
longer closes at budget 0 because the first hop now prefers the cheaper 24 October Warsaw
fare, which leaves no remembered onward fares; a live budget finds its own.
`mustInclude=Sofia, ground=720, budget=0` closed Sofia by coach both ways (`home: HOME`, the
way out named as such, the return "home by coach ... estimated"); before the must prune the
single beam slot went to Katowice, a state that could never close. Not exercised live: a 429
inside a run and a closed tab (typechecked, not provoked).
