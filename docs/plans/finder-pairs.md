# Finder on paired one-way tickets

_Written 2026-10-12. Code: `lib/pairs.ts` (the engine), `lib/finder.ts` (targets, which engine),
`lib/board.ts` (the graph-timed gap shared with the boards), `app/api/finder/route.ts`._

## What went wrong

The owner searched from GHV, OTP, SBZ and BBU, 22 October to 30 November, there on 26 October,
3 to 5 nights, anywhere. The custom search answered with **one** deal: Thessaloniki in, Corfu
out, labelled "about 4h 51 between them". The real trip is a coach to Igoumenitsa and a ferry,
about seven hours.

Measured that day:

- A Kiwi **return** search to "anywhere" answers with its 15 cheapest itineraries, and **all 15
  were split tickets**: land in one city, fly home from another one anywhere. After the split
  filter, one was left. Returns to a country behave the same: 13 of 15 split for Greece.
- The must-include date was applied **after** searching. Kiwi's 15 cheapest across the whole
  period mostly left in November and were thrown away.
- The gap between the two cities was a straight line turned into a drive estimate. Thessaloniki
  to Corfu is 280 km on a map, so it passed the 300 km limit and showed a drive time that does
  not exist.

The owner's words: "it can't be only this one; I can fly to a city, then from that to another
one, and back to any city in Romania, not only the departure airport".

## The method now

1. **Dates first.** With a must-include date the way out is searched only on
   `[max(from, include - maxNights), min(include, to - minNights)]`, and the way home only on
   `[max(include, out + minNights), min(to, out + maxNights)]` (the union over the out days).
   Without one, out is `[from, to - minNights]`. For the owner's search: out 22 to 26 October,
   home 26 to 31 October. Return searches for a city use the same windows.
2. **Out.** One-way searches from all the traveller's airports to "anywhere", then one per
   nearby country (`targetsFor`, or the region's or listed targets; the been list as before).
   Each itinerary is an out edge: landing airport, city, date, arrival time, price, link.
3. **Where home may land.** Every airport of the home country (large or medium, of a city on
   the globe) gets its ground leg from the traveller's point, timed on the ground graph (one
   walk, memoised), or by road only where the feeds have no station near either end. Over six
   hours it is not a way home; the traveller's own airports always are. The home searches aim
   at this list as one comma list, own airports first. From Ghimbav: GHV, OTP, SBZ, BBU, then
   TGM (212 min), BCM (250), CLJ (276), CND (348), IAS (359); CRA (385), TSR, SCV, OMR are out.
4. **Home per destination country.** The countries are ranked by their cheapest out edge and
   the best ten (fifteen when exhaustive) get one search each, **from** the airports landed at
   there, the other airports of those cities and the airports the graph reaches within four
   hours of the first three (at most 8; Germany: `BER,NUE,FMM,CGN,STR,DUS,DTM,NRN`), **to**
   the home list. Before, these went from the country's name to "Romania": measured, 6 of 15
   answers for Germany landed at SCV, OMR, CRA or IAS (past six hours from Brasov) and 11 of 15
   for Italy landed outside OTP, so Berlin never had a way home of its own.
5. **Home per city.** Landing cities that still have no stay after step 4 get a search of
   their own from their own airports (four of them, six when exhaustive), cheapest way out
   first, so a big country cannot spend its 15 answers on one or two routes. One that would
   repeat a country search exactly is skipped.
6. **Two cities by air.** From the cheapest landing cities, one per country (three, four when
   exhaustive), a one-way to "anywhere" on the days between the first out day and the last
   back day. The cities those land in that have no way home yet share one more home search.
   A trip is out, hop, home, with at least a night in each city.
7. **Pairing.** A way home pairs with a way out when it leaves from the landing city (or
   another airport of it), or from a city the ground graph reaches from the landing airport
   within 4 hours (3 hours for trips under 5 nights). Times are checked, not just dates: the
   next flight must leave at least 3 hours plus the trip between after the previous one lands
   (Kiwi's times are local; the margin absorbs a zone step), and nights count from the day the
   traveller lands. The must-include date must lie between landing and the flight home.
8. **Score** = all flights + ground estimates + ground hours at 6 euro an hour (route-finder's
   balanced rate). Every airport carries its real ground leg from the traveller, own airports
   included, on the way out and the way home; only airports marked as theirs with `returnTo`
   are free. When own airports counted as zero, no other airport of the country could win.
9. **Kept**: three stays per landing city on distinct out dates, and beside them, never
   instead of them, up to three second cities by land and three by air per landing city, one
   date each; 150 deals at most.
10. **Deals.** `price` is all flights; `url` is the way out, `url2` the way home, `hop` the
    flight between two cities (from, to, city, date, nights in the first city, price, url).
    `backTo` is the home airport when it is not the one flown from. `backFrom`/`backFromCity`
    mark the second city (by land or by air), and `gapMin`/`gapKm` the graph-timed trip
    between. `homeGapMin` is the ground leg from a home airport that is not the traveller's,
    `groundPrice` all ground legs shown, `pairNote` the trip in plain words ("Katowice for 2
    nights, then fly to Milan for 1 night; three one-way tickets"), and `pair: true`. Deals
    stream after each home search.
11. **Returns stay** for a search naming only cities (`where=Milan`), where a return is a proper
    return. A split ticket there goes through the same graph rule.

## The gap rule (boards too)

`lib/board.ts` `groundGap(a, b)` walks the ground graph from airport `a` up to 10 hours. It
memoises a walk per airport (a typed array, 48 kept) and an answer per pair (20,000 kept). It
reads the stations within 20 km of `b`: drive to the first station, the graph's minutes, then
the drive from the last station plus 5 minutes. The graph includes the ferry ports, so "no
path" usually means a sea or a border, not a gap in the data. The road estimate over the
straight line is used **only** when neither airport has a station within 20 km and both are
in the same country; anything else without a path is `by: "none"`, which `gapFits` always
refuses. `gapFits` keeps a trip when the graph's minutes are within 4 hours, or a trusted road
is within 120 km. Past 700 km in a straight line the graph is not asked.

`sensibleTicket`, `ticketGap` and `toDeal` use it, so the nightly boards
(`scripts/ingest/boards.ts`), `scripts/ingest/deals.ts`, `lib/purpose.ts` and `lib/scan.ts` all
apply the same rule. `toDeal` writes the graph's minutes into `gapMin`, never a "none" gap's.

Measured offline (graph of 10 October), after the change:

| Pair | Straight km | Timed | Kept |
| --- | --- | --- | --- |
| Thessaloniki to Corfu | 280 | no path, stations at both ends: none | no |
| Kos to Bodrum | 72 | no path, two countries: none (was a 75 min "drive") | no |
| Rhodes to Dalaman | 72 | none (was a 75 min "drive") | no |
| Samos to Izmir | 70 | none (was a 73 min "drive") | no |
| Tirana to Podgorica | 112 | no stations at either, two countries: none | no |
| Paros to Naxos | 24 | graph 47 min (a ferry) | yes |
| Berlin to Hamburg | 274 | graph 182 min | 5+ nights only |
| Brussels to Amsterdam | 158 | graph 101 min | yes |

## Bounds

- Searches: 1 + 12 out, 10 countries and up to 4 cities home, 3 hops and 1 home from where
  they land = **31** for "anywhere" (measured: 31, 30 sent live, 18 s). Exhaustive: 1 + 18 +
  one "anywhere" per origin (at most 5) out, 15 + 6 home, 4 + 1 hops = at most 49. A region
  uses 12 (18) of its countries, a list at most 4 targets. Hidden-city tricks read the out
  answers and cost no search in pairs mode. Kiwi's gate memoises every search for 24 hours, so
  a repeat costs nothing (measured: the same search again sent 1).
- Ground graph work: one walk per landing airport (for the second cities around it and the
  pairing), 10 to 90 ms each, with a yield between airports so the stream keeps moving.
- The route memo key carries the engine (`pairs-2`) and the traveller's point. A run in which
  any search after the way out failed, refused or not, is not memoised, and its done line
  says so (`homeFailed`, `homeRefused`). The done line also counts `citySearches`,
  `hopSearches`, `hops` and `sent` (searches that left the process during the run; other
  features' searches in the same process count too).

## The traveller's point: a bug found on the way

`GET /api/finder` read the point with `latLon(p.get("lat"), p.get("lon"))`, and `latLon(null,
null)` answers `{ lat: 0, lon: 0 }` (`Number(null)` is 0). Every search without lat/lon (all
non-exhaustive ones from the globe) put the traveller in the Gulf of Guinea, so no airport but
their own was ever within six hours. That, not the price of the ground leg, is why the first
run had no home airport outside the four. The route now reads the point only when both
parameters are present. `lib/params.ts` itself belongs to another lane (it also feeds walk,
eats, hotels and events).

## The owner's search, after

Measured 12 October with the new engine through the dev server.

Run 1 (the full engine, still with the 0, 0 point, so home only to GHV, OTP, SBZ, BBU): 31
searches, 149 out edges to 47 cities, 868 valid pairings, **85 deals in 32 cities** (was 43 in
21): 25 two cities by land (Katowice in, Krakow out, 1h 55; Pescara in, Rome out, 3h 30;
Budapest in, Vienna out, 3h 15; Berlin in, Nuremberg out, 3h 29) and 7 two cities by air
(Thessaloniki 2 nights then Budapest 3, 117 euros; Pescara 3 then Tirana 1, 99; Katowice 2
then Athens 2, 140). Cheapest stays: Chisinau 53, Pescara 76, Tirana 89, Budapest 92. No
Corfu anywhere.

Run 2 (point fixed; capped to three countries, Germany, Italy and Greece, to stay inside the
day's search budget: 4 new searches, the rest from the memo): home list GHV, OTP, SBZ, BBU,
CND, CRA, BCM (the point is the middle origin, Otopeni, since the globe sends no lat/lon for a
plain search). 45 deals in 19 cities, 6 coming home to another Romanian airport (Pescara in,
Rome out, home to Bacau, 58 euros; Genoa in, Milan out, home to Craiova, 110; Katowice 2
nights then Milan, home to Craiova, 93). Berlin now has a stay of its own (165 euros, 5
nights), which the country-name search never gave it. The full run with the fixed point needs
about 15 more live searches and was not made on 12 October.

## Not done here

- The client's `dealKey` (`gw|dst|out`, `lib/ui-types.ts`) merges a stay and a two-city pair
  that share the way out. It should also use `back`, `backFrom` and `hop.to`.
- The UI does not yet show `hop`, `pairNote`, `homeGapMin`, `groundPrice` or the tickets of a
  pair; the detail view reads "Home to" with nothing after it when `backTo` is unset (use
  `backTo ?? gw`), and the card labels a pair's price "return".
- `components/Globe.tsx` sends lat/lon only for exhaustive searches, so the traveller's point
  is the origin airport nearest the others (Otopeni among GHV, OTP, SBZ, BBU, since BBU is
  Bucharest Baneasa), not where they live.
- `lib/params.ts` `latLon` should return null when either value is missing or empty.
