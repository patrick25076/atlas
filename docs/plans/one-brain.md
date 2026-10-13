# One brain: one search over a dense price map, verified live

Patrick, 2026-10-12: "did we overfit from Bucharest ... do we get flight prices from other airports to build the
edges, because we wouldn't know where to go next if there is only one edge ... why so many engines, which ones are
better, I don't understand when to use each, it feels like prechoosing destinations without seeing the cheapest and
smartest ways ... I hope we cache everything ... it should add in the graph updated prices somehow."

Status: **built 12 October (Patrick: "yes build the plan"), one brain on in production.** The engines it replaces still
run when the map finds nothing, and with engine: classic; they come out once the nightly benchmark has a week of
history.

## What was built (12 October)

| Step | Built | Measured |
| --- | --- | --- |
| 1. Breadth | scripts/ingest/tp-edges.ts, nightly (job tp-edges): Travelpayouts for 233 cities, 3 months, the cheapest to every place and of every day | 54,657 fares, 2,024 places, 0 failed, 4.7 min; with a day either side the map grew from 24,225 to 172,956 flights; Hanoi from 6 places to 125 |
| 1b. A* | lib/flight-graph.ts relaxedHome: a date-free reverse Dijkstra from home bounds every city's way home; the search orders by cost plus that bound | November loop: 120,000 labels and cut off before, 20,796 and proven cheapest after (2.2 s); two cities: 33,378 to 7,073 labels (0.2 s) |
| 2. Live check | lib/search.ts: the best 5 trips' flights priced live on their day (up to 12 searches), ranked again, written to the fare memory | November two cities, budget 12: 12 flights answered, all found on their day, 5 trips fully live; Budapest to Milan was 21 estimated, 37 live |
| 3. One brain | SearchQuery.engine, ATLAS_ONE_BRAIN=1 in production: the map and its live check answer alone | benchmark at budget 0: both brains found the best price in 7 of 8 answered questions (mean regret 0), the one brain in 0.1 s a question against 1.5 s |
| Benchmark | bench/cases.json (9 questions, the owner's own trips among them), scripts/bench.ts, nightly job bench, engine room Benchmark tab | Hanoi to Vientiane now 96 euro (the owner's 93, the old 157) |

Open: the two-week trip to anywhere with 4 to 7 places still reaches the search's limit (flagged); Lisbon on exact
dates finds nothing at budget 0 (the map holds no fare on those days, the live engines do); the Southeast Asia loop
still chains small Malaysian and Thai towns (taste, waiting for the owner's own method); overland links (the curated
list) are being researched.

**Overland, later the same day:** public/data/overland.json, 90 links researched with sources (55 Southeast Asia, 18
Balkans, 17 Turkey, Caucasus, Central Asia and Morocco; 67 high and 23 medium confidence; closed crossings such as
Thailand to Cambodia left out), laid into the price map every day at the middle of their fare range (lib/overland.ts),
towns without an airport as places of their own, and into the graph walk. A bus or train leaves from the city centre,
not an airport, and its fare counts as a ticket. Benchmark: Hanoi to Vientiane 38 euro door to door by the sleeper
bus (157 before); both brains found the best in 8 of 8, the one brain in 0.1 s a question against 2.6 s.

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

## Far from Bucharest (12 October, evening)

Patrick: "what about to and from San Francisco, did we overfit on Hanoi now, what about South America, Paraguay,
Chile, Bolivia, also other parts of Asia, Central Asia, Georgia, Azerbaijan ... make sure the tool calls in chat do
not fail and that we have most data."

What was wrong: San Francisco to Mexico, South America or Peru found **0 trips**. The nightly map keeps a city's 80
cheapest places a month, so far homes had no way back (Mexico City to San Francisco was in none of it), and Machu
Picchu, the Uyuni salt flats or "Peru and Bolivia" were not things the search could be asked.

| Built | What it does |
| --- | --- |
| World origins (scripts/ingest/tp-edges.ts) | the nightly Travelpayouts import asks from 416 cities (every country's two biggest cities with a large airport, Bishkek among them): 67,459 fares, 2,128 places |
| Home fares (lib/tp-map.ts) | each search adds the cached fares out of and into the traveller's own cities for the months of the window (kept 12 h, shared) |
| Densify (lib/search.ts) | fewer than 6 trips on the map: up to 8 live questions (half the budget), the way a person asks: home to the target's cities and back, all at once, then one city at a time for the ones the first answer missed and for every must city, then the hops between them; all inside the window the map searches. Kiwi answers 15 flights a question, so asking eleven hubs at once is mostly the cheapest pair on fifteen days |
| Overland, round 2 (public/data/overland-more.json) | 186 more sourced links: Peru, Bolivia and the Atacama, the Southern Cone, Colombia and Ecuador, Mexico and Central America, South Asia, East Asia, the Middle East and East Africa (546 one-way links in all) |
| Several countries | to: "Peru and Bolivia" is the region countries:pe,bo (URL and chat) |
| Must places | SearchQuery.must (chat: mustInclude): the price map's search is aimed at them (a bit per must on every label), not filtered afterwards; a named place is a must too |
| Pass back through | a train or coach back through a city already stayed in, the same day (Aguas Calientes, Cusco, the flight home) |
| Home country | a place named in the traveller's own country (Cusco from Lima) may be a stop |
| Landmarks (lib/landmarks.ts) | Machu Picchu is Aguas Calientes, Lake Titicaca Puno, the salt flats Uyuni, Angkor Wat Siem Reap, Bali Denpasar (it was a town in India), and about 30 more |
| A to B | cheapest_way offers a sourced overland link (Lima to Cusco by coach, 22 h) |
| Chat | a turn stops at 270 s and its run is saved with the reason; a run is saved once |

| Search (live budget 16 to 22) | Before | After |
| --- | --- | --- |
| San Francisco to Mexico, a week in November | 0 trips | 6; Guadalajara 276 euro, Guadalajara, Queretaro, Mexico City 337 euro, checked live |
| San Francisco to South America, a loop in January | 0 | 14; Lima, Puno, Copacabana, La Paz by coach, 1,032 euro |
| San Francisco to Peru | 0 | 23; Lima, Arequipa, Cusco by coach, 672 euro |
| San Francisco to Peru with Machu Picchu and Lake Titicaca | 0 | 20; Cusco, Aguas Calientes by train, back through Cusco, Puno by coach, Lima: 848 euro, checked live |
| Lima to Machu Picchu | 0 | 224 euro: coach to Cusco, the train there and back, the flight home |
| Brasov to Georgia and Armenia, a loop | (no such query) | 19; Kutaisi, Tbilisi by train, Yerevan by coach: 179 euro |
| Brasov to Tashkent, Samarkand and Bukhara | (no such query) | 15; with Khiva, all by train: 475 euro |
| Brasov to Central Asia, a loop | 4 | 10; Almaty, Bishkek, Osh, Tashkent 506 euro |
| Brasov to Baku and Tbilisi, 2 nights each | 0 | 1; 404 euro checked live (no land border open, so all flights) |
| Santiago to Paraguay | 0 | 1; Asuncion 191 euro |
| Brasov to Japan in March: Tokyo, Kyoto, Osaka | 1 (80 h of travel) | 20; Osaka, Kyoto by train, Tokyo: 910 euro checked live (the overland links now run 200 days ahead, not 100, so a March trip has the Kyoto train) |

Benchmark (budget 0, the map alone, 17 questions): 16 answered; the new cases answer from the map alone the next time,
because every live answer was written to the fare memory. Lisbon on exact dates still needs live prices.

Chat evaluation (12 real questions on the dev server, up to 20 live searches a turn): 0 tool calls failed in the last
round. The model put eight Central American countries in to and "Peru and Bolivia" in the wild region; both now read as
several countries. San Francisco to Peru and Bolivia with Machu Picchu, Lake Titicaca and the salt flats answered in
one search: La Paz, Uyuni by overnight coach, Puno, Cusco, Aguas Calientes, 1,208 euro. Lima to Cusco offers the
22 h coach (26 to 66 euro) beside the 55 euro flight.

## Two searches that found nothing, debugged (13 October)

How: the engine room's Live tab keeps each run's question exactly as the server got it ("The question as the server
got it") and every step. Reading the stored input, then running the same query on the dev server and the price map's
search directly (cheapestTripsIn, with and without each rule), found these.

| Search | What the engine room showed | The cause | Fixed |
| --- | --- | --- | --- |
| Southeast Asia, 12 to 30 nights | graph 0 trips in 18 ms; the walk "58 to 60 nights" | the Wild drawer still held 59 nights while the bar said 12 to 30, and the drawer won, silently: 58 nights do not fit the map's 35 days | the bar's range wins, the loop's nights are kept inside it and the note says so; the bar and the drawer now move together; 20 trips |
| Anywhere, 20 to 31 October including the 26th: why not Warsaw and Gdansk | 16 trips, none to Gdansk | the map keeps one trip per sequence of cities and the day to include was checked after it: Warsaw and Gdansk on 20 to 24 October took the slot and was dropped, so 24 to 31 October was never seen | the day is a rule inside the search: 59 trips; Warsaw 3 nights and Gdansk 4 by train, 97 euro, among them |
| (the same) | | 97 euro needs 4 nights in Warsaw, past the style's 2 to 3 a place | a short trip of several places may take one night more, at a small taste cost |
| (the same) | | it still came 25th of a run that answers 20, below Katowice and Ostrava: the map ranks euros and hours, not what a place is worth | a run answers 30; permutations of the same places count once. Open: a place's worth in the map's ranking |
| Georgia and Armenia | the cheapest 20 all Armenia | several countries meant "in any of them" | a stay in each (falls back, said, when no trip can) |

Also: a graph step with 0 trips now says why; an empty answer is no longer cached for the hour; a mended query is
cached under the question as asked. A regression caught by the benchmark on the way: a place's country made any stop
in Peru count as Machu Picchu (0 trips), fixed before it shipped.

## Australia: why the wild loop beat the search (13 October)

The owner searched Sydney for two weeks in February and got 3 changes over America for 1,437 euro; the wild loop
through Oceania found Qatar through Doha, 1 change, and six cities for 1,504. Read from the two runs in the Live tab:

| Cause | Fixed |
| --- | --- |
| "Sydney" was Sydney, Nova Scotia (YQY): of two cities with one name, the search took the nearest, and Canada is nearer to Brasov. The way home from Sydney did the same. The wild loop asked for a region, so it never met the name | of cities sharing a name, the likeliest: population over (1 + km/2000) squared (lib/board.ts cityLikeliness). Sydney and Melbourne are Australia's, Cordoba and Valencia Spain's from Europe, Santiago Chile's. The To box now sends the code of the city picked, and a trip's way home the stop's own code and country |
| A change of plane was 25 euro whether it was a 2 h hop or a 35 h journey, an hour 6 euro, and four airlines on separate tickets nothing: 3 changes on Pegasus, AirAsia X, AirAsia and Jetstar for 550 beat Qatar's 1 change for 695. The walk prices an hour at 9 to 12 | flightTaste (lib/flight-graph.ts), in the map's search and in the final ranking alike: a change twice the style's on a long haul (over 8 h), every airline past two the same again, hours past 20 counted twice. Sydney now: a return for 1,035 euro with 2 changes each way on two airlines; Qatar's 1 change heads the loops |
| In February the map had no Australian domestic flight: the nightly Travelpayouts import covered three months, so the map's loop was empty and only the walk, asking live at each hop, found one | the import covers five months. Every live answer is also kept in the fare memory for three days: an hour after the owner's wild loop, the map alone answered the same Oceania loop with 13 trips, Qatar out, Jetstar between, 1,499 euro |
