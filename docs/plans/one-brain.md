# One brain: one search over a dense price map, verified live

Patrick, 2026-10-12: "did we overfit from Bucharest ... do we get flight prices from other airports to build the
edges, because we wouldn't know where to go next if there is only one edge ... why so many engines, which ones are
better, I don't understand when to use each, it feels like prechoosing destinations without seeing the cheapest and
smartest ways ... I hope we cache everything ... it should add in the graph updated prices somehow."

Status: **proposal, waiting for Patrick's yes.** The caching asked for is done (see the end).

## What was measured (12 October)

| The price graph today | |
| --- | --- |
| Flights in it | 24,225 (19,348 nightly, 4,877 from the fare memory) |
| Cities with a flight out | 242 |
| Romania's share | 15 % (14 cities); Bucharest 1,454 flights, 1,115 of them from our own test searches |
| A city searched every night (149 outside Romania) | about 126 flights, but only **11 places** to fly on to |
| A city known only from live searches (79) | about 11 flights |

So yes: Bucharest is over-known (our testing), and every other city is under-known. A nightly search is one "anywhere"
question per airport per three days, and Kiwi answers its 15 cheapest itineraries, which cluster on the same few
places. From Hanoi the graph knew 6 places; Hanoi to Vientiane only on 7 December.

The Travelpayouts cache (the Aviasales data our token already reads) knows, for the same cities, the cheapest
recent fare to every place it has seen, per month, at most a week old, for free and without touching Kiwi's limit:

| City | Places the graph knows | Places Travelpayouts knows (one month) |
| --- | --- | --- |
| Hanoi | 6 | 161 (Vientiane 93 euro, one stop, a 52 h layover) |
| Budapest | 64 | 158 |
| Krakow | about 11 | 117 |

## Why there are so many engines

Each was built to answer one kind of question when it came up (deals, then A to B, loops, Wild, pairs, long stays,
groups). The Search tab already picks them for you, so you never have to. But each one decides **where to look
before it knows what is cheap**: the paired search aims at the four countries the graph found cheapest, the walk asks
for the 15 cheapest places from each stop (or the region's six biggest hubs), the graph knows 11 places a city. The
cheapest clever route is often never looked at, which is what you felt.

## The proposal: one search, three layers

1. **The price map (breadth, nightly and continuous, free).** Every one-way price we can know, each with its source
   and age: Kiwi's nightly graph (bookable, six weeks), Travelpayouts' cache (every direction from about 300
   airports, the cheapest per month, and per day for the directions that matter), the fare memory (every live search
   by every visitor, written back the moment it is seen), the ground graph and a curated list of overland links where
   no timetable is public (Hanoi to Vientiane by bus, Bangkok to Vientiane by train).
2. **One search (exact over the map).** The Dijkstra on euros that already runs first in Search, over the denser map:
   cheapest first, fewer stops, taste as a tie-breaker, a long layover as a free night. A month-level price is an
   estimate usable a few days either side of its date, and says so.
3. **Verify live, then write back.** The best few trips have each hop re-priced live with Kiwi over two days either
   side (one search a hop). Confirmed prices replace estimates, the trips are ranked again, and every price seen is
   written to the fare memory, so the next visitor's map is better ("add updated prices to the graph").

The paired search, the walk, A to B and the price calendar become this one search with a different target or shape.
Long stay and group stay as thin wrappers around it.

## How we will know it is better (evaluable)

A benchmark of real questions with your own best answers: Brasov to Warsaw, train to Gdansk and home; two weeks in
Southeast Asia; a cheap long weekend in November; and the trips you show me how you build by hand. Every night (and on
every change) the engine runs them and the engine room scores each: the cheapest door to door against your answer,
stops, hours, and how many live searches it took. The Live tab already records every real search and chat turn.

## Steps

1. Travelpayouts edges into the map, nightly, with source and age (about a day).
2. The verify layer for Search's best trips, writing back to the fare memory (one to two days).
3. Search on the one engine behind a switch, compared on the benchmark against today's engines (a day).
4. Retire the engines it beats.

## Done now (12 October): caching for everyone

Answers are kept for an hour in Postgres (lib/shared-cache.ts, table `answers`), shared by every server instance and
every visitor: the same search, walk or way home asked again within the hour is read back in about 0.3 s, runs no
engine and spends no live search, and the Live tab says so. Before, the memo lived in one server's memory, so a
repeat that landed on another instance ran again (today's log: repeats from 0 ms to 33 s). Live prices already
flow back into the graph: every live search writes the fare memory, and the graph reloads it (the last three days)
every ten minutes.
