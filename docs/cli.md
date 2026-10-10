# The Atlas command line

_Written 2026-10-10._

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
| `wild sea 21`, `/wild southeast asia 3 weeks`, `Balkans loop 10 nights` | a wild loop (`wild_trip`): served from the store; a new build only with `--live-cap 60` | 0 or about 60 |
| `stay thailand 2 months`, `2 months in Bali` | long-stay bases (`long_stay`): live only with `--live-cap 16` | 0 or about 16 |
| `place Porto`, `Porto` | facts, the guide's sights, the best months, events worth the trip there | 0 |
| `itinerary Lisbon 3 nights from 2026-11-14`, `itinerary Lisbon 3 nights, Porto 2 nights from 14 Nov`, `itinerary Porto 2 from Brasov on 1 Dec`, or a list of stays without the word: `Lisbon 3 nights then Porto 2 nights` | a day-by-day itinerary (`make_itinerary`): the days, the food, events on those days, estimated costs | 0 (about a minute of model writing) |
| `ask is Porto nice in October` | one turn with the agent, the same prompt and tools as the chat; prints the answer and the tools it used | what the agent spends, under the cap |
| `help` | the list of examples | 0 |

A plain question ("is Porto nice in October") is handed to the agent; so is anything the
parser does not read as one of the shapes above. A leading verb (`route`, `wild`, `stay`,
`place`, `getaways`) is read as the slash command of the same name.

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
