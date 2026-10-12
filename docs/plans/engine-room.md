# The engine room, and taste in the loops

Patrick, 2026-10-12, after a Southeast Asia loop: "I don't think they're the cheapest first ... I don't think we
exhaust and get enough prices for certain days ... they're not made with taste ... I'm looking for fewer stops,
and if I have a layover I would prefer it to be over 20 hours and get a night extra ... create me something where I
can see how the app thinks ... which one uses the graphs, which not ... then I can show you how I do it."

## What happened with Hanoi to Vientiane (157 euro)

Found in the fare memory: the loop builder (a Wild loop, chat or Search, 17:32 local) searched "the region's hubs
from Hanoi on Mon 7 Dec", that one day only, and Kiwi answered Don Mueang 76, Bangkok 80, Bali 126, Vientiane 157.
It took Vientiane because the place's worth (fame, a new country) was taken off the price without a ceiling: up to
about 115 euro, more than the 77 euro between the two. Hanoi to Vientiane was never priced on any other day (the
engine room's "one hop" shows every other day as "never searched"), and Hanoi is not searched at night, so all the
graph knows about leaving it is what someone's live search left behind. The overland ways a backpacker would take
(the sleeper bus, or Bangkok and the train to Vientiane) are not in the ground graph: there is no public timetable
for Vietnam or Laos.

## What changed

- **Fewer stops.** A change of plane costs 12 euro at Cheapest (25 balanced, 60 comfort) in the loop builder and in
  the price graph's Dijkstra. Ranking only, never a price shown.
- **Taste breaks ties, it does not pay double.** A place's worth now saturates towards 45 euro at Cheapest (80, 130):
  a famous city still beats a plain one, never by more. The same Hanoi search now goes to Bangkok for 70.
- **A long layover is a free night.** A live ticket with a layover of 18 to 60 hours in a city the walk knows becomes
  a stop of its own (that city, those nights), its hours not charged as travel, worth a little less than a real stop.
  Not yet seen live (the cheapest fares rarely have one); the rule is in place and traced.
- **The engine room** (`pnpm dev`, then http://localhost:3210/admin; 404 in production unless ATLAS_ADMIN=1):
  - *The machine*: every front door, engine and source of data, what uses what, the algorithm and what it minimises;
    the table of which feature uses which graph.
  - *Watch a loop*: the graph walk with its trace: the knobs of the run, the beam depth by depth (kept and dropped),
    and for any state every way out it weighed, cost split into ticket, hours, changes of plane and worth. Budget 0
    replays it on the fare memory for free.
  - *Price graph*: what last night's job and the fare memory hold, city by city (nightly or live only), flights by day
    (the six-week cliff), a city's flights as a destination by day grid, and one hop day by day with every sighting.
  - *Graph trips*: the Dijkstra on euros alone, and for every flight of a trip the flights out of the same city a day
    either side that it was chosen over.

## Seen in the engine room, to fix with Patrick's own method

- Cheap trains with a worth bonus cost less than nothing, so a loop chains small towns (Ipoh, Hat Yai, Nakhon Si
  Thammarat) because they are cheap to reach, not because anyone would go.
- One search per stop over the stop's own days: a hop is priced on two days at most. More days per search (a wider
  window, then the nights adjusted) would find the cheap day; it costs nothing extra in searches.
- Asia is known only through live searches: add the region's hubs to the nightly graph (Hanoi, Saigon, Bangkok,
  Kuala Lumpur, Singapore, Bali, Manila) when a run's searches allow.
- Overland links where there is no timetable (Hanoi to Vientiane by bus, Bangkok to Vientiane by train, Saigon to
  Phnom Penh, Siem Reap to Bangkok): a curated list with typical fares and hours, marked as such.
