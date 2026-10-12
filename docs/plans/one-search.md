# One search: the app as one flow

Patrick, 2026-10-12: "look how bad it is, the whole experience, there's too many features that
should be merged in one, Skyscanner is intuitive, but this should be smarter". Chosen layout:
**one search, one list, plus an Advanced drawer** for the long trips.

## The shape

- **Three tabs**: Search, Ask, My trips. Deals, Explore, Trips and their modes (Short loops,
  Wild loops, Long stay, Group, A to B, the custom search, the Smart loop, Everywhere) stop
  being places to go; each becomes something the one search can return or a filter on it.
- **The search bar** (top of the Search tab, and the command line in the top bar fills it):
  - **From**: the traveller's place, airports listed (as today).
  - **To**: Anywhere (default), a city or town, a country, a region ("Southeast Asia").
  - **When**: exact dates (out and back, or one way), a flexible window ("20 to 30 Oct"), a
    must-include day, a month, or anytime (the next six months, cheapest dates).
  - **Nights**: a range (default 3 to 7), or "one way".
  - **Who**: 1 adult by default; a group editor lives in Advanced.
  - **Search**.
- **Advanced drawer** (one tap under the bar, closed by default):
  - **Trip shape**: Any (default), Return to one place, Two cities, A loop of 3+, Long stay.
  - **Wild loop through a region** (region chips, 5 to 90 nights).
  - **Long stay** (1 to 6 months, bases).
  - **Group**: who is coming, their airports and free dates.
  - Nights per place, avoid countries, trains between places, longest flight: the Trip style.
- **Filter chips under the bar** (instant, client side): Direct only, Under N h a leg, 1 city,
  2 cities, 3+, Trains OK, Events on, New countries (Been), Price max.
- **One results list**, ranked by price (Trip style can switch to balanced or comfort), each a
  **trip card**: price, route line with plane, train and coach icons ("Brașov ✈ Warsaw 🚆
  Gdańsk ✈ Otopeni"), dates, nights per place, travel hours, badges (direct, events on, new
  country, gem). The globe shows the same list as price tags and the selected card's route.
  The list streams as results arrive; the globe draws the search while it thinks.
- **One trip page** for any card: the legs with booking links (one per ticket), **Ways home**
  (a calendar of the days around, direct first, to any home airport), hotels for the dates,
  events on during the stay, sights and food per place, **Make it a plan** (the itinerary),
  save, share.
- **Ask** (the chat) works on the same search: "make it direct", "add Toruń", "cheaper",
  "what about November" change the search and the list; the chat explains and asks at most
  one question; its cards are the same trip cards.
- **My trips**: saved itineraries and searches.

## Which engine answers what (the user never picks one)

| The search | Engine |
| --- | --- |
| To = a place, dates exact | route finder (A to B) + paired one-ways, ways home |
| To = anywhere or a country, window | paired one-ways (lib/pairs.ts), flight graph first |
| Shape = two cities or a loop, or nights > 7 with To anywhere | flight graph trips (Dijkstra on euros), then the walk to confirm live |
| To = a region, nights >= 7 (Advanced: Wild) | wild by walk |
| Advanced: Long stay | long stay |
| Advanced: Group | group |
| When = anytime | price calendar (scan) per destination, flight graph everywhere |
| Events on | purpose events and city feeds as a filter and badge |

Results from all engines are normalised into one `TripResult` shape (legs, stops, total,
hours, source, booking links) so one card and one trip page render them all.

## What goes away

The Deals, Explore and Trips tabs, the mode rows, FinderForm as a separate panel, the route
card as a separate mode (it becomes the trip page), the Smart loop form, the Purpose list.
Their engines stay; only their front doors go. Old links (?view=trips&mode=wild, ?deal=…)
map onto the new search.

## Status

_2026-10-12, the engine stream._ The engine behind the one search is built and tested against the dev
server. The search bar, the trip card and the trip page are other streams' work.

**What exists**

- `lib/trip-result.ts` (client safe, type imports only): `SearchQuery`, `TripResult`, `TripLeg`,
  `TripStop`; one converter per engine (`tripFromDeal`, `tripFromRouteOption`, `tripFromWalkLoop`,
  `tripFromGraphTrip`, `tripFromEverywhereCity`, `tripFromWildTrip`, which returns the trip and its
  alternatives, `tripFromLongStayBase`, `tripFromGroupOption`); `applyFilters` for the chips;
  `parseSearchQuery` (the checks, shared by the route and the URL reader); `searchQueryToParams` and
  `searchQueryFromParams` (a readable URL: `from`, `at`, `ap`, `home`, `to=place:Gdansk`,
  `when=window:2026-10-22..2026-11-30@2026-10-26`, `nights=3-5`, plus `q=<json>`); `skeletonFromTrip`.
- `lib/search.ts` and `GET /api/search?q=<json>` (NDJSON): the flight graph first (everywhere on
  exact dates, cheapest trips over a window, the must-include day narrowing it, a country, region or
  place kept by avoiding every other country), then the live engines of the table above within the
  budget (default 25, 0 means stored prices only). Every result is placed, given door-to-airport legs
  when its engine leaves them out (so all prices compare door to door), badged (direct, events on,
  a train between cities), checked against Been, de-duplicated by cities and days (the cheaper
  stays), ranked money first and cut to 60. The filter chips are applied after the memo (30
  minutes), so a chip change costs nothing.
- `lib/way-home.ts` and `GET /api/way-home`: the chat's way_home logic, extracted. `wayHome()` answers
  the calendar; `wayHomeToolShape()` gives the tool's old output so the chat can switch without
  change.

**Measured** (dev server, 12 October; 11 live Kiwi searches in all by the process counter):
anywhere from Brasov, 22 Oct to 30 Nov around the 26th, 3 to 5 nights, budget 0: 14 trips from the
graph in under a second (6 two-city, 8 returns; no loop, since three places of 2 to 3 nights need 6
nights); a loop shape at 6 to 7 nights gave 5 loops (graph and walk). Gdansk 24 to 31 Oct: 7 trips,
the graph's €80 Otopeni return cheapest of the plain returns, loops through Warsaw or Katowice by
train. Southeast Asia, Wild 14 nights, budget 0: 10 loops from the graph, progress lines from the
walk. Way home from Gdansk 29 to 31 Oct, direct: the €32 Ryanair to Otopeni on the 31st, €45 door to door.

**Open**

- The paired search costs about 31 searches for "anywhere", over the default budget: with the graph's
  answer it is aimed at the four countries the graph found cheapest (about 16); with an empty graph
  it runs anyway and says so.
- The search budget is read off the process-wide Kiwi counter, so a search running beside another
  may count the other's searches.
- One-way to anywhere comes from the graph only (no live engine prices one-ways to anywhere yet).
- The chat's way_home tool still has its own copy until the brain stream switches it to `lib/way-home.ts`.
- An engine already running cannot be stopped mid-way (the engines take a deadline, not a signal), so a
  search left during its live engines still spends what those engines spend.
- A Wild loop that closes nothing at budget 0 is a thrown "no loop" from the walk, so that answer is
  not kept in the memo and a repeat runs again (cheaply: nothing live is spent at 0).

**Fixes after review** (same day; all tested at budget 0, no live Kiwi search spent):

- Wild loop from the Advanced drawer: the loop's region is the destination when To is Anywhere (the
  graph and the target check used to let Italian loops through as "Southeast Asia"); a To outside the
  region is a 400 that names both. Tested: sea, 14 nights, 2 to 30 Nov: 10 loops, all in MY and TH;
  To Paris with Wild sea: 400 "To is Paris, but the Wild loop is set to Southeast Asia".
- One-way over a window or a month: the graph is asked once a week across the window (each ask a day
  plus or minus three) and nothing leaving outside the window is kept; to anywhere, a country or a
  region each city appears once, at its cheapest day. A one-way month no longer runs into the next
  month. Tested: 20 to 30 Nov, 55 cities, none before the 20th or after the 30th, departures through
  the 30th; December: 11 results, all in December.
- Long stay with To on Anywhere: runs over the cheap-to-live region nearest the traveller (Balkans
  from Brasov) and says so in the note, instead of a 400. At budget 0 it says why nothing was priced.
- A place in To may carry its city or airport `code` (`{kind:'place', name:'Cordoba', code:'ODB'}`,
  in the URL `to=place:Cordoba:ODB`). Without one, a name several cities share is read as the one
  nearest the traveller, and the engines are handed the code so they cannot pick the other one.
  Tested: Cordoba from Brasov goes to ODB, Spain; with code COR to Argentina.
- `/api/way-home` takes `code` (a city or airport code, such as a trip stop's) and `cc` (its country),
  and `from` may then be left out; a shared name without them is read nearest the traveller's home
  point (Florence from Brasov is FLR, Italy, not FLO, South Carolina). Names with a slash
  (Leipzig/Halle, Metz/Nancy) pass the check.
- Two callers of one search share the run and the second is replayed every line so far, then follows
  live (it used to wait silently for the end). The route stops listening when the client leaves, and
  a run every caller has left starts no live engine it has not started yet, and is not kept.
- "Train between cities" (badge and the Trains chip) only counts a train, coach or ferry between two
  different stops of the trip, not the train to another airport for the flight home.
- A flight priced from the fare memory is a ticket, never ground: the route finder's Lisbon option
  read "€0 plus €149 ground" with a 117 euro ticket; it now reads €117 plus €32.
- A door-to-airport leg whose two ends share a name reads "Brașov to Brasov airport (GHV)".
- `rank`, `moneyOf` and `HOUR_EURO` are exported from `lib/search.ts` for the chat.

**Fixes after the browser test** (same day, 12 October):

- The big number on a card and on a globe tag is the price door to door (`doorPrice`: tickets plus
  the ground estimate), with the tickets and the ground under it. The list ranks by that sum, so a
  card showing only the ticket made the Cheapest list look out of order (Krakow €34 below Rome €54).
  The Price chip compares the same sum.
- One card per route for flexible dates (`oneEachRoute`): the same cities on other days fold into
  the cheapest, which carries "N more dates". Exact dates list as before. The count says the cards.
- Titles of two-city trips read "Budapest, Venice" from every engine (the paired one said "and").
- The flight graph takes `minPlaces` and `top`: a two-city search asks for two places, a loop for
  three, and "any" runs returns and multi-city apart, 20 each. Cheap returns had filled the graph's
  ten slots, so November two-city from Brasov gave 2 trips; it now gives 21, most with a train or
  coach between (Bologna and Venice, Milan and Venice), and a November loop gives 21 (Milan,
  Verona, Venice €71 door to door). All under 5 s at budget 0.
- Every engine's results pass one shape check (return 1 place, two cities 2, loop 3 or more).
- The chat: never asks whether to include the other home airports (it always searched them); a
  coach between two places counts as overland. Its follow-up chips come from the last main tool
  and drop what that search already did (no "Make it direct" after a direct search).
- Checked in the browser: trip page (three tickets, Ways home calendar, hotels, sights), Make it
  a plan, the Ask tab, `?view=deals` lands on Search, phone width 390 with no sideways scroll.
  Harness: 334 tools, 0 failed (`--live-cap=0`).
