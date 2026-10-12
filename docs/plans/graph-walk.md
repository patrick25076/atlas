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
  heuristic for the way home, in the units a loop is scored in (fare, plus hours with airport
  time at the way home's rate, plus the stops penalty): the cheapest one-way into a home
  airport the fare memory saw from that city in the last day, else half of tonight's board
  return fare to it, else a cheap direct one-way by distance (20 euro plus 0.04 per km, half
  an hour plus 800 km an hour in the air). A state that cannot still pass through every must
  city in the depth left never joins the frontier.
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
- **Allowed countries** (Wild's region, `allowedCountries` or `region`): every stop is in one of
  them, and the flight hops are targeted (see "Far regions" below). Until 2026-10-12 the way in
  could land in a hub outside them, because an "anywhere" search from home rarely reached the
  region; the targeted way in reaches it directly, so that exception is gone.
- **Taste, diversity and the lookahead** (2026-10-10, night): see the section of that name
  below. In short: an easy train or coach is charged at three quarters of the hour value, the
  beam keeps one city per slot plus at least one overland and one flying branch, the
  heuristic looks one free ground hop ahead, `style=unique` weights hidden gems up and the
  biggest hubs down, and `avoid` takes country groups ("dach", "like:DE").
- **Beam**: depth by depth. Every open state of a depth is sorted by cost plus heuristic and
  the best `beam` are expanded (default 3), depth up to `maxStops` (default and ceiling
  ceil(maxNights / the fewest nights a stop), at most 16). Depth by depth rather than one global
  queue, so a cheap deep branch cannot take the slots of a sibling that was not looked at yet.
  The states of a depth are expanded side by side (their searches share Kiwi's gate, six at a
  time), each search reserved from the budget before it starts. The budget defaults to about two
  searches a stop plus the way in and home (2 x maxStops + 2, never under 12, at most 40), and
  the beam narrows when the searches left only just cover the cheapest branch's way to a closed
  loop (see "Far regions").
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
plus `nightsPerStop` (2 or 2-3), `maxStops` (1 to 16, default scales with the nights), `beam`, `budget`
(default about two a stop plus the way in and home, never under 12, cap 40), `ground` (minutes, default
330, 0 for flights only), `tradeoff`, `exclude` (Been, ISO2), `mustInclude`, `avoid` (countries or
cities, codes or names; a country's exact name wins over a city of the same name, so Singapore or Malta
avoids the country), `prefer`, `countries` (allowed), `region` (a `lib/wild.ts` REGIONS key), `style`. Validated with
`lib/params.ts`; a bad value is a 400 `{error}`. NDJSON lines `{node}`, `{edge}`, `{loop}`,
`{progress}` and a final `{done: WalkResult}`, kept alive every 15 s, `maxDuration` 120. An
answer is kept for an hour per normalised question and served as one `{done}` line; two
callers asking the same thing share one walk (the second gets only the done line). A walk
the breaker refused or tripped, the deadline or the caller cut, or whose searches all failed,
is not kept. `logSearch("walk", ...)`,
fire and forget, codes and numbers only.

## Taste, diversity and the lookahead (2026-10-10, night)

The owner, after the first walks: "it does not think like me: I would have done Brasov-Warsaw
plane, then Warsaw-Gdansk train, then Gdansk to another city and that back to Brasov or Sibiu
or Otopeni", and earlier "I need to find the cheapest thing but also more unique; I don't like
Germany, I don't like countries like Germany".

- **Ground hours** (`chargedHours`): a train, coach or ferry of up to 6 h counts its hours at
  0.75 of the tradeoff's euro per hour (no security queue, centre to centre, usable time); a
  flight keeps its 90 minutes of airport time; a drive or a longer overland day counts in full.
  One rule for every edge (`offer`, the ground ranking, `child`, the ground way home), so a
  ground hop and a flight to the same city are compared on the same terms. Real hours (the
  loop's `hours`) are counted apart. A flight never lands in a country already visited, so
  Warsaw to Gdansk is overland by construction; Vienna to Bratislava is where the two compete.
- **The beam** (`pickBeam`) keeps its size, so the search count does not move, with these
  rules: one state per city (three ways into Prague all ask the same way home); from depth 2,
  at most `beam - 1` children of one parent (a slot this leaves empty goes to the next state
  in order, so the beam never shrinks); the state with the cheapest known way to close
  (`bestKnown`: a remembered way home inside its own window, one ground hop away, or a train or
  coach to the door) is always walked, replacing its own costliest sibling when its parent has
  its share; at least one state that arrived overland when the depth has one (flights are
  nearly always cheaper on paper, so "plane, train, plane" was never walked unless asked for);
  at least one that arrived by air when the depth has one (ground hops are known before any
  search and flights are not). Each swap is a `considered` line.
- **The lookahead** (`homeAfter`): a first stop is rarely the city the traveller flies home
  from. Before a depth that can still go deeper is cut to the beam, its 30 cheapest states that
  can still leave by date get the cheaper of their own way home and the best ground hop out of
  them (fare and hours at the rate) plus that city's way home, counted only when that way home
  is known: a remembered fare leaving inside the window the neighbour could fly home in, a
  board, or a train or coach to the door. Never a distance guess: with guesses, a city ringed
  by towns nobody has a fare for (Katowice, with Krakow, Rzeszow and Ostrava) outranked Naples,
  whose coach to Rome and Rome's remembered way home are the cheapest loop the memory holds;
  its children filled the next beam and nothing closed (the review's finding, 0 loops where the
  morning engine closed 3). The next city's worth is left out of it: with the worth in it,
  every city with towns around it looked cheap and the beam filled with coaches.
- **No search left** (budget 0, spent, the breaker open, the caller gone): a way home nobody
  knows can never be found, so a state whose way home rests on a distance guess, for itself and
  for every ground neighbour, is ranked behind every state that can close (`BLIND_PENALTY`, on
  the beam's order only; the early stop reads the honest priority). Boards do not count here:
  half a return says a route exists, but only a remembered fare, a live search or the ground
  graph closes a loop.
- **`style=unique`** (also "hidden gems", "off the beaten path", "underrated", "smaller
  cities", "small towns", "less crowded", "not touristy", "avoid the touristy places";
  `wantsUnique`, read clause by clause like `wishTilt`, so "not unique, big cities" and "no
  hidden gems" do not turn it on): a hidden gem as the globe marks it (`lib/gems.ts isGem` on
  `fame.json` views and listings, World Heritage within 40 km, `city-places.json`; a city
  served from 30 or more places with under 40,000 views is a bad fame row and never a gem,
  which keeps Krakow, at 8,880 views in the file, out) +45 worth points, a city below hub size (under 60 destinations) +20, a country new to the traveller
  +15 more, one of the 25 biggest hubs by `hubDegree` (Frankfurt, Paris, Amsterdam, Istanbul,
  Munich, Moscow, London, Barcelona, Madrid, Rome, Dusseldorf, Brussels, Manchester and the big
  American and Asian ones) -50, and the hub-size part of `worth` (up to 30) taken back. Points
  are halved into euros like every bonus. The style is in the route's memo key already.
- **Country groups in `avoid`** (`countryGroup`): "dach" or "germanic" (DE, AT, CH, LI),
  "benelux" (BE, NL, LU), "nordics" or "scandinavia" (DK, NO, SE, FI, IS), "baltics" (EE, LV,
  LT), "balkans" (AL, BA, BG, HR, XK, ME, MK, RS), "iberia" (ES, PT, AD), "british isles" (GB,
  IE, IM, JE, GG), written as people write them ("the Balkans", "Benelux countries", "Baltic
  states", "the Iberian peninsula"), and "like:DE", "like:Germany", "like Germany", "countries
  like Germany", "places like Germany" or "somewhere like Germany" (the group the country is
  in, else the country alone; "countries like Germany and Austria" joins the groups). The walk
  names the group in `considered`. An unknown "like" target falls through to the plain place
  lookup and its note.
- **The itinerary** (`lib/itinerary.ts skeletonFromWalk(loop, origin)`): the loop's stops with
  their nights and Kiwi photos, its legs in order (each flight with its booking link, times,
  carrier and a note when the fare came from the memory or a board; each train, coach or ferry
  with its minutes and an estimated fare; the drive to and from the home airport as the usual
  access leg), titled in plain words ("Gdansk, Bydgoszcz and Warsaw"). Its `source` is
  `"loop"` for now: a new `"walk"` member breaks the label map in `components/Itinerary.tsx`
  (TS2741) and `lib/itinerary-server.ts` turns an unknown source into `"custom"`. Switch to
  `"walk"` in the same change that adds it to both.
- **The route** keeps an answer only when it lost fewer searches than it made (before: only
  when not every search failed), and logs `unique` as a boolean.

### Tested 2026-10-10, night (10 searches reached Kiwi)

Through `GET /api/walk` in-process, a test wrapper refusing any Kiwi search past 10. The
owner's case, `g=GHV,SBZ,OTP&home=RO&lat=45.657&lon=25.601&label=Brasov&from=2026-10-20&to=2026-10-30&minNights=5&maxNights=6&nightsPerStop=2&maxStops=3&beam=3&budget=10`,
with the ground hours and the overland rule but before the lookahead and the city and air
rules: 10 searches, 4 loops, every one with a coach leg: Naples → Rome 123 euro (Ghimbav to
Naples 17, coach to Rome, Rome to Otopeni 74, drive home 13), Naples → Bari 185, Naples →
Salerno → Bari 186, Naples → Salerno 188. The same URL again: one `done` line in 0 ms. With
`style=unique&avoid=dach` in the same process the cap refused 7 of its searches: Naples →
Tirana 138 and Naples → Bratislava 150, no German, Austrian or Swiss edge (Berlin, Munich,
Vienna and the rest dropped out of the explore's usable list).

After the lookahead and the beam rules, from the fare memory alone (`budget=0`, 0 searches):
the owner's case walks Naples, Thessaloniki and Katowice, then Ostrava and Rzeszow overland
from Katowice and Bratislava by air from Naples, and closes Naples → Bratislava → Warsaw 221
and Naples → Bratislava 150 (the overland branches need live ways home it was not allowed).
`style=unique&avoid=dach` walks Katowice, Naples, Thessaloniki, then Ostrava, Rzeszow and
Tirana, and closes Naples → Tirana 138. `avoid=like:DE&mustInclude=Gdansk` closes Gdansk →
Bydgoszcz → Warsaw 198 (drive, fly Otopeni to Gdansk 40, train, train, fly Warsaw to Otopeni
95, drive): the owner's own shape. Repeats of each answered one `done` line in 1 ms. A
nonsense `avoid` is a plain note. Not measured: the final engine with a live budget (see the
review fixes below).

### Review fixes 2026-10-10, late night (6 searches reached Kiwi)

The review found the lookahead above a regression: on the same fare memory, at `budget=0`, the
morning engine closed Naples → Rome 123, Naples → Tirana 137 and Naples → Bratislava 150; this
one closed nothing, for the owner's case, for `nightsPerStop=2-3` and for
`style=unique&avoid=DE,AT,CH`. Reproduced with both engines side by side on one memory. Fixed by
the known-only lookahead, the per-parent cap, the no-search ranking, `bestKnown`, and a heuristic
in score units (the sections above). Measured after the fix, all on the same memory:

- Owner's case at `budget=0` (GET /api/walk in-process, 0 searches): 5 loops, Naples → Rome 123
  (fly Ghimbav to Naples 17, coach to Rome 19, Ciampino to Otopeni 74, drive 13), Naples → Rome
  → Tirana 178, Naples → Rome → Malta 190, Budapest → Graz → Bratislava 170, Budapest → Kerkyra
  251. The same URL again: one `done` line in 1 ms.
- `style=unique&avoid=like:DE`, `budget=0`: Naples → Tirana 137, Gdansk → Bydgoszcz → Warsaw
  198 (plane, train, train, plane), Naples → Foggia → Bari 161.
- `avoid=like:DE&mustInclude=Gdansk`, `budget=0`: Gdansk → Bratislava → Budapest 193 (score
  151), Poznan → Gdansk 180, Gdansk → Prague → Bratislava 199; `bestKnown` took Bydgoszcz's
  slot, so the plane, train, train shape of the night run is not among them at beam 3.
- The owner's case at `budget=6` with every search refused by the test (searches left, so the
  board-based lookahead and the guesses rank): Naples → Rome 123 kept by `bestKnown` ("Rome kept
  in the beam in place of Salerno"), then Naples → Bratislava → Budapest 154 and three more.
- Live, `budget=6`, 6 searches reached Kiwi, on the engine before `bestKnown` and the score-unit
  heuristic: 4 loops, best Naples → Bratislava 150 and Naples → Bratislava → Budapest 154;
  Rome was not walked (Katowice → Ostrava took a slot and its live way home came back at 242).
  That run is why `bestKnown` exists. The final engine with live searches was not run: the
  fix round's cap was 6 searches.
- Words: "Benelux countries", "countries like Germany and Austria", "places like Germany",
  "balkan countries", "scandinavian countries", "iberian peninsula" each resolve to a group;
  `wantsUnique` is false for "not unique, big cities please" and "no hidden gems", true for
  "small towns", "less crowded", "not touristy" and "avoid the touristy places".
- A walk whose searches all fail (February, nothing remembered, 3 refused) says "3 of 3 live
  searches failed and nothing remembered closes a loop for these dates; try again in a few
  minutes", and the count line reads "3 searches through the gate: 0 answered, 3 failed".

## Where it is used (to wire)

- A chat tool `walk_trips` ("find me a loop from here, 6 days, 2 days a city, not Germany"):
  call `walkTrips` with the visitor's gateways, point and label, `avoid` for the "not X" words,
  `mustInclude` for named cities; read `loops[].why` and `note`.
- Wild loops: wired 2026-10-12 as `lib/wild-walk.ts wildByWalk`, the default engine of `/api/wild`
  (see "Far regions" below).
- Short loops: `maxGroundMin` 5 to 12 h, `maxStops` 2 to 3, tradeoff `price`.
- The globe: while a walk runs, every `{edge}` is a faint arc from the expanded node (`from` is
  a city code or `HOME`; `lat`/`lon` are the far end), the `{node}` lines pulse, a `chosen`
  edge brightens, a `{loop}` draws the closed loop; the panel shows the beam as a tree (city,
  cost so far, date).

## Far regions, nights a stop and the Wild engine (2026-10-12)

The owner: "I want the wild trips and stuff to be like 2-3 days per location max, can I make these
settings, does it work with Dijkstra and all". Before this, a 21-night Wild loop stayed 3 to 6 nights a
stop (long trips 8 to 12), the walk's default was 2 a stop, and the walk could not reach Southeast Asia
from Brasov: its first hop asked "anywhere", and the fifteen cheapest places from Brasov are all European.

- **Targeted hops.** With a region (`region`, or `allowedCountries`) the way in is one search from the
  home airports to the region's biggest hubs, and every later flight hop one search to the hubs of the
  countries not seen yet: the biggest city of each such country first, six cities at the most, every
  airport of each, as one comma list. Kiwi answers a comma list of country names with nothing (measured:
  "Thailand,Vietnam,...,Laos" from GHV,SBZ,OTP, 0 results in 265 ms), while airport lists work (the way
  home has always used one). A stop whose memory already holds six usable destinations skips its search.
- **Revisits.** When the trip needs more stops than the region has usable countries (each stop at its
  most nights), a flight may land in a country already seen; never in a city already seen. Otherwise a
  region walk holds at most two cities a country (a train from Warsaw to Gdansk is still fine): the
  first live Southeast Asia walk went Kuala Lumpur, Ipoh, Penang and Alor Setar by rail, because rail
  hops cost no search and a few euros, and left Malaysia only for its last stop.
- **Nights a stop.** A range is honoured exactly: every stop leaves inside [arrive + min, arrive + max],
  the last stop flies home inside its own range. A pair with equal ends is exact too (`[2, 2]`, or `2` in a
  query, is two nights, never three: the trip style's "at most 2 a place"); only a bare number passed to the
  engine (and the default 2) keeps one day of slack. The classic chain reads `nightsPerStopMax` the same way,
  and the stored key writes an equal max as `n2-2`. `maxStops` defaults to ceil(maxNights / min), at most 16.
- **Arrival day of a remembered fare.** A fare from the memory or a board knows its day, not its hour, so the
  stop's arrival is estimated from the flight's length and the longitude it crosses (a midday departure
  assumed): Bucharest to Kuala Lumpur, 14.8 h, lands the next day, so the first stop keeps its nights. A
  live itinerary with the same price wins over a remembered one, because it knows its real arrival.
- **Departure window.** `departBy` caps the first leg's day from home; Wild passes its departure window's
  last day there and the trip's end as `to`, so from == to is one fixed day in both engines.
- **Budget.** Default 2 x maxStops + 2 (never under 12, at most 40), said in a progress line.
  `needToClose` counts the searches a state still needs with nothing remembered (a hop per further stop
  at the most nights a stop, and the way home). The beam's width at a depth is 1 plus the searches left
  over that need, capped at the beam: wide early, one branch late. A stop whose searches left only just
  cover its need takes its most nights (`tight`), so the loop closes in the fewest hops; the answer says
  how many stops were lengthened that way.
- **Other switches.** `maxGroundMin: 0` turns trains and coaches off; `maxFlightHours` drops longer
  itineraries everywhere (memory, live, boards, the way home). Fly legs carry `stops` and `route`.
- **The Wild engine** (`lib/wild-walk.ts wildByWalk`): the classic builder's parameters plus `avoid`,
  `searchBudget` and `maxGroundMin`; the same departure window (`wildWindow`, passed as `departBy`), nights
  given or take one, the walk's window the last departure day plus the most nights, two to three nights a
  stop when none are given (longer only past about seven weeks, so 16 stops still fill the trip), a 150 s deadline unless the caller
  gives one. The best loop becomes a `WildTrip` (stops with nights, living costs per stop as
  `lib/wild.ts` counts them, visas, warnings; legs with times and booking links, ground legs as rail,
  coach, ferry or road; totals; the judge's verdict), the next four loops its alternatives. It throws a
  plain sentence when nothing closes. `/api/wild` uses it unless `engine=classic`, `variants > 1` or
  `startFrom`; the classic chain now honours nights a stop exactly too (`rangeHop`, `rangeHome`).

### Tested 2026-10-12 (12 searches reached Kiwi: 2 probes, 10 in the run)

- Probe: `flyTo` = the eight Southeast Asian country names as a comma list answered 0 itineraries.
- `GET /api/wild?engine=walk&region=sea&nights=14&nightsPerStop=2-3&from=2026-11-20&to=2026-11-24&searches=10`
  from Brasov (GHV, SBZ, OTP), in-process, before the two-cities-a-country rule: 10 searches, 46 s, 67
  `{walk}` lines (10 nodes, 51 edges, 1 loop, 5 progress). Kuala Lumpur 2 nights, Ipoh 2, Penang 3, Alor
  Setar 3, Hat Yai 2: fly Bucharest to Kuala Lumpur 313 euro (14.8 h, one stop), rail to Ipoh, Penang,
  Alor Setar and Hat Yai (estimated, 8 to 18 euro), fly Hat Yai to Bucharest 449 euro (19.8 h, two stops),
  drives to and from Otopeni 13 each; flights 762, ground 75, living 430, all 1,267, 106 a night, 12
  nights on the ground (the night out is on the plane), 25 November to 8 December. The same URL again:
  stored, one JSON answer in 1 ms, 0 searches.
- The judge returned nothing on every trip: with 600 output tokens the model's object stopped after
  `score` and `tweaks`. At 2,000 it judged the loop 61 ("Hat Yai's two nights are hard to justify against
  the nearly 20-hour, two-stop journey home").
- `region=balkans&nights=7&nightsPerStop=2-3&searches=0`: 0 searches, 5 states expanded, no loop and the
  plain note (the fare memory holds no way home from the Balkans for those dates, and Brasov's ground
  reach does not touch them; with `ground=720` 13 states, still none).
- The open walk from memory, `budget=0`, 20 to 30 October: Warsaw → Chisinau 84, Katowice → Rzeszow →
  Warsaw 125, Warsaw → Lodz → Gdansk 177 (plane, train, coach, plane), every stop 2 or 3 nights;
  `countries=PL,CZ,SK,HU`: Budapest → Bratislava 133, Warsaw → Budapest 108, Budapest → Bratislava →
  Katowice 213.
- Classic, no search: 10,000 simulated chains over `rangeHop` and `rangeHome` (14, 21, 7 and 28 nights at
  2-3, 14 at 3-4) put no stop outside its range; 14 nights at 2-3 lasted 13, 14 or 15 nights. 60 nights at
  2-3 is refused before a search ("need 20 stops; the most is 16").
- After the review fixes (4 live searches): `wildByWalk` for `region=sea`, 10 nights, `from=to=2026-11-20`,
  `nightsPerStop=2` with max 2, `searchBudget=4` closed no loop (four searches are too few for a far
  region at one-day hop windows) and threw its plain sentence. Read back from the memory with `budget=0`:
  the way in was asked for 2026-11-20 only (before, up to the 22nd), the remembered long-haul fares put
  Kuala Lumpur, Singapore and Hanoi at 2026-11-21 (before, the 20th), and every hop out was a one-day
  window two nights after arrival. The open walk at `[2, 2]` from memory, 20 to 30 October: Budapest,
  Bratislava, Vienna at exactly 2 nights each.
- The live run had the targeted hops, the parallel expansion and the width planner (beam 3 at the first
  depths, 1 at the last). Not run live: the two-cities-a-country rule, added after it and checked from
  memory only.

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
