# The Atlas command line

_Written 2026-10-10; the trip style added 2026-10-12._

Atlas has one command language, spoken in two places: the command bar in the top bar of the
site (press `/`) and `pnpm atlas` in a terminal. Both read the line with `parseCommand` in
`lib/command.ts` (pure, no network, the same answer for the same words on the same day), and
both run the same engines: the terminal calls the chat's tools (`atlasTools` in
`lib/agent-tools.ts`) directly, so a table in the terminal is what the chat would have seen.

## Running it

```
pnpm atlas <words> [flags]
# or, without the package script:
node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/atlas.ts <words> [flags]
```

`.env.local` supplies the keys (Bedrock for `ask` and itineraries, Tavily and Foursquare for
the research behind an itinerary). Nothing else is needed: Kiwi has no key.

## What it understands

| You type | It runs | Kiwi searches |
| --- | --- | --- |
| `Brasov to Lisbon`, `Bucharest -> Rome one way`, `how do I get from Cluj to Paris`, `Lisbon to Porto by train`, `Lisbon 4 nights from Brasov` | the cheapest and the fastest way (`cheapest_way`): nearby airports, a train to a bigger airport, two tickets through a hub, open-jaw, the ground graph | up to 12; none under 150 km |
| `to Lisbon 14 Nov 4 nights`, `OTP to LIS 2 weeks`, `Brasov to Lisbon 20 Dec to 3 Jan` | the same, from where you are, on a day, for a stay | up to 12 |
| `events in february`, `carnival`, `jazz festivals in march`, `what's on in Lisbon in november`, `Christmas in Vienna` | events worth the trip (`events_worth_travelling_for`), each with the cheapest fare from your airports; a named place also lists the curated events near it | up to 4 (0 with `--live-cap 0`) |
| `lisbon in november`, `weekend in Rome`, `getaways under 3h this weekend`, `anywhere warm in december` | getaways: a live period search (`find_getaways`) when the cap allows 20 searches, else tonight's boards (`cheapest_deals`) | 0 or about 20 |
| `loop from Brasov 20 to 30 Oct 5 to 6 nights 2 nights a stop`, `3 cities in 6 days`, `Brasov to Warsaw then train then home`, `cheap unique loop next month not germany`, `loop 2 weeks, 2-3 nights a place, only trains between cities`, `/loop Brasov 6 days` | a loop of the cheapest hops (`walk_trips`, the graph walk of lib/graph-walk.ts): one "anywhere" search from home, the cheapest next hops by plane, train or coach from each stop (trains and coaches from the Dijkstra over the ground graph in lib/ground.ts), the cheapest way home; printed as a tree of legs and stays | about 2 a stop plus the way out and home (12 at least, 40 at most), never past the cap; 0 still walks the fare memory |
| `wild sea 14 nights`, `/wild southeast asia 3 weeks`, `Balkans loop 10 nights`, `/wild balkans 14, max 3 nights a city, unique` | a wild loop (`wild_trip`), built by the graph walk aimed at the region (`--engine classic` for the older chain by country): served from the store; a new build only when the cap covers it | 0, or about 2 a stop plus 4 (18 for 14 nights at 2 to 3 a place, 40 at most); classic about 60 |
| `stay thailand 2 months`, `2 months in Bali` | long-stay bases (`long_stay`): live only with `--live-cap 16` | 0 or about 16 |
| `place Porto`, `Porto` | facts, the guide's sights, the best months, events worth the trip there | 0 |
| `itinerary Lisbon 3 nights from 2026-11-14`, `itinerary Lisbon 3 nights, Porto 2 nights from 14 Nov`, `itinerary Porto 2 from Brasov on 1 Dec`, or a list of stays without the word: `Lisbon 3 nights then Porto 2 nights` | a day-by-day itinerary (`make_itinerary`): the days, the food, events on those days, estimated costs | 0 (about a minute of model writing) |
| `ask is Porto nice in October` | one turn with the agent, the same prompt and tools as the chat; prints the answer and the tools it used | what the agent spends, under the cap |
| `style` (`/style`, `settings`) | the trip style this run uses, in the words the agent reads | 0 |
| `help` (`/help`) | the list of examples and flags | 0 |

A loop is the graph walk unless a far region is named or the words say weeks overland
("Balkans loop 10 nights", "/loop sea 21", "loop through Vietnam 3 weeks" stay Wild).
"Through", "across", "around" or "in" a European country for less than two weeks is a walk
kept to that country (`loop through Poland 6 days`). What a walk line reads: `from X`
(where it starts; default where you are), a window (`20 to 30 Oct`, `next month`), the
length (`5 to 6 nights`; `6 days` is 5 to 6 nights, `3 cities in 6 days` too), nights a stop
(`2 nights a stop`, `2-3 nights each`), the number of cities (`3 cities`, `4 stops`), cities
to pass through, places to avoid and the style.

Cities to pass through come from a chain written out (`Brasov to Warsaw by plane, Warsaw to
Gdansk by train, then another city and back to Brasov or Bucharest`), from A-B pairs
(`Brasov-Warsaw plane, then Warsaw-Gdansk train`, with or without spaces round the hyphen;
`Cluj-Napoca` stays one place), from `come back from X`, `with X`, `via X`, and from names
joined by `and` (`multi city trip Warsaw and Gdansk`). The first place of a chain is the
start only when the chain begins with a place: `fly to Warsaw then train to Gdansk` and
`Warsaw by plane then train to Gdansk` start where you are and pass through both, since a
loop never stops in its own start country. `back to Brasov or Sibiu` names the ways home,
which are your airports already.

Trip style words, read before anything else so `2-3 nights a place` is never the trip's own
length (lib/command.ts `readTripStyle`), for a walk and a wild loop alike:

- nights a place: `2-3 nights per place`, `2 to 3 days each`, `2 nights a city`,
  `2-3 days per location max`. A day at a place counts as a night there.
- a cap: `max 3 nights a city`, `at most 3 days per place`, `up to 4 nights in each city`
  read as 2 up to the cap (`max 2` is 2).
- the pace: `slow pace` is 3 to 4 nights a place, `packed` or `fast pace` 1 to 2, when no
  nights a place are typed.
- between places: `only trains between cities`, `trains between places`, `trains only`,
  `by train only` (ground hops up to 8 hours instead of 5.5), `flights only`, `no trains` (no
  ground hops). The command carries this as minutes in its `ground` field (480 or 0), the
  unit /api/walk and /api/wild read, so the shell can pass it on as it is. Outside a loop or a
  wild line these words stay part of the line: `cheap flights only to Spain in november` is
  still the cheapest dates to Spain, `Brasov to Vienna by train only` a route to Vienna.
- `unique`, `hidden gems`, `not touristy`, `off the beaten track`: the style unique.

Whatever the line does not say comes from the trip style (below): the walk and the wild
loop stay its nights a place, use its tradeoff, taste, longest flight and avoid list. The line's
own words win for that one search.

Places to avoid: `not Germany`, `no Austria or Switzerland`, `not via Munich` (Munich),
`nothing like Germany` and `countries like Germany` as `like:DE`, and the group words
`dach`, `germanic`, `benelux`, `nordics`, `baltics`, `balkans`, `iberia` and `british isles`
(`the dach countries` works too). `not by plane` is a way to travel, not a place, and is
left out. The style: `unique`, `hidden gems`, `not touristy`, `off the beaten track` all
mean style unique.

In the browser the shell runs a walk line through `walkFromCommand` in components/Globe.tsx,
which dispatches `atlas:walk` with the /api/walk query. `walkCommandQuery` in
lib/chat-widgets.ts is the same rule as a pure function, and the one `pnpm check:tools`
tests; it takes the trip style as its last argument and fills what the line left out. The
shell builds its query on its own for now, so a change to one is not a change to the other;
the harness also checks the shell's copy rule (every field copied as it is, the style filling
only what is empty), which is why `ground` is minutes and never a word.

`style`, `trip style`, `prefs`, `preferences`, `settings` (with or without a slash) open the
trip style, and `help`, `guide`, `?`, `how does this work`, `how to use atlas` the guide: the
same words the command bar opens by itself. Anything else about them ("what can you do",
"open my trip style") is a question for the agent.

A plain question ("is Porto nice in October") is handed to the agent; so is anything the
parser does not read as one of the shapes above. A leading verb (`route`, `wild`, `stay`,
`place`, `getaways`, `loop`, `walk`) is read as the slash command of the same name.

Dates: `14 Nov`, `Nov 14`, `14/11`, `2026-11-14`, `today`, `tomorrow`, `next friday`,
`this weekend`, `next week`, `next month`, `in 2 weeks`, a month name (`november`, `early
december`, `late march`), and ranges (`14 to 18 Nov`, `20 Dec to 3 Jan`, `march to may`,
`friday to sunday`). A day without a year is the next one that is not in the past; a
weekday (`friday`, `this friday`) said on that weekday is today, `next friday` is the one
after. A range ending on a weekday ends on the first one after its start. Stays: `4 nights`, `a week`,
`2 weeks`, `3 days` (two nights), `a weekend` (two or three), `2 months`. Also `one way`,
`flex 2` (`flexible` alone is three days either side), `under 3h`, `under €100`. Words that
qualify a trip (`and back`, `by train`, `direct`) never become part of a place name. A
chain (`Rome to Paris to London`) runs the first hop; the whole chain is offered as an
itinerary in the app's command bar.

## Flags

| Flag | Meaning |
| --- | --- |
| `--from "lat,lon,label"` | where you are; default Brașov (45.657, 25.601) |
| `--airports OTP,SBZ` | the airports searched nightly; default GHV, SBZ, OTP |
| `--live-cap N` | the most Kiwi searches this run may make; default 12. It is the turn budget the tools spend from, and a command whose usual cost is above it runs from stored data |
| `--today YYYY-MM-DD` | the day the words are read against |
| `--json` | the raw tool answer instead of the tables |
| `--all` | every suggestion the parser made, then the first is run |
| `--engine classic` | build a wild loop with the older greedy chain by country instead of the graph walk |

## The trip style

The app keeps one trip style per browser (lib/prefs.ts, the Trip style button or `/style`):
nights a place (default 2 to 3), the pace, price against comfort, famous or unusual places,
countries to avoid, the longest flight, and whether trains and coaches between places are
welcome. Every chat turn carries it, the agent's system prompt states it, and the tools take
it as their defaults: `walk_trips` and `wild_trip` stay its nights a place (a longer trip
gets more stops, up to 16, and more searches), use its tradeoff and taste and never stop in
its avoided countries; `cheapest_way` caps the trip at its longest flight plus three hours
door to door and leads with the cheapest, the fastest or the better of the two by its
tradeoff; `make_itinerary` plans at its pace; `find_getaways` and `group_trip` take its nights
only when you changed them from the default (a getaway is one place). What you say in a
message wins for that trip only ("3 to 4 nights in each this time"). Each answer says in
`tripStyle` which defaults it took.

The terminal has no browser, so the same style is given as flags, over the same defaults:

| Flag | Meaning |
| --- | --- |
| `--nights-per-place 2-3` | nights in each place, a number or a range (1 to 14); default 2-3 |
| `--pace slow\|balanced\|packed` | default balanced |
| `--tradeoff price\|balanced\|comfort` | default balanced |
| `--taste popular\|unique\|mixed` | default mixed; unique favours smaller places and hidden gems |
| `--avoid dach,DE` | countries (ISO2) or group words never to stop in |
| `--max-flight-hours 8` | the longest single flight |
| `--no-ground` | no trains or coaches between places, flights only |

`pnpm atlas style --taste unique --tradeoff price` prints the style a run would use.

Every run ends with the number of Kiwi searches it sent. Kiwi throttles an address after
bursts (see docs/architecture.md); keep the cap low when trying things.

## Examples

```
$ pnpm atlas Brasov to Bucharest
> Brasov to Bucharest
1. Train from Brasov to Bucharest  €34  2.5 h  [cheapest, fastest]  ground-only
     train Brasov to Bucharest, 2.5 h, €17 (estimate)
considered: ... 140 km apart: ground only, no flight searched
Kiwi searches this run: 0 (cap 12)

$ pnpm atlas loop from Brasov 20 to 30 Oct 5 to 6 nights 2 nights a stop --live-cap 3
> A loop from Brasov, 20 to 30 Oct, 5 to 6 nights, 2 nights a stop
  ... Walking from Brașov (GHV, SBZ, OTP), 2026-10-20 to 2026-10-30, 5 to 6 nights, 2 a stop, up to 3 stops, beam 2, budget 3.
  ... Done: 2 loops, 3 live searches, 7 states expanded.
1. Naples → Rome  €123  12 h of travel  2026-10-21 to 2026-10-26, 5 nights
   Brașov, plane, Naples, coach, Rome, plane, Bucharest
   ├─ fly  Brasov to Naples, 2026-10-21 12:55, 2.2 h, €17, Wizz Air Malta  live
   ├─   book: https://kiwi.com/u/...
   ├─ stay  Naples, IT, 2 nights from 2026-10-21
   ├─ coach  Naples to Rome, 2026-10-23, 2.6 h, €19 (estimate)  ground
   ├─ stay  Rome, IT, 3 nights from 2026-10-23
   ├─ fly  Rome to Bucharest, 2026-10-26, 2.1 h, €74, Ryanair  memory
   └─ drive  Bucharest to Brașov, 2026-10-26, 2.2 h, €13 (estimate)  ground
   why: coach Naples to Rome 2.6 h instead of a flight
Kiwi searches this run: 3 (cap 3)

$ pnpm atlas wild sea 14 nights --nights-per-place 2-3 --taste unique --live-cap 18
> A wild loop through Southeast Asia, 14 nights
(the graph walk aimed at the region: a search into its hubs, then the cheapest next hop
from each stop, 2 or 3 nights each, then home)
tripStyle: from the traveller's trip style: 2 to 3 nights a place, unique places

$ pnpm atlas style --nights-per-place 2-3 --avoid dach
Trip style: 2 to 3 nights a place, balanced, avoiding one choice
The traveller's trip style: 2 to 3 nights in each place; a balanced pace; ...

$ pnpm atlas events february --live-cap 0
> Events worth the trip, February 2027
dates                     event               where                 fare
2027-02-07 to 2027-02-17  Carnival of Venice  Venice, IT            not priced
...

$ pnpm atlas itinerary Lisbon 3 nights from 2026-11-14
3 nights in Lisbon (2026-11-14 to 2026-11-17, 3 nights, planned)
Day 2 2026-11-15 Lisbon: Alfama lanes and evening fado
  morning eat: Breakfast at ... [Foursquare 9.1/10]
...
```

## In the browser

The top bar's command bar ranks the same suggestions on every keystroke (`parseCommand(text,
today)`, the first is the best guess, "Ask Atlas" always last) and runs the chosen one on the
globe. The chat dispatches `atlas:command` with a line (an event's "Show on the map" sends
`/events Venice 2027-02-07 to 2027-02-17`), so anything the command bar can run, the chat can
ask it to. `COMMAND_HINTS` in lib/command.ts is the list of examples both show.
