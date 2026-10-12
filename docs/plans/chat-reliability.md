# Chat reliability: tools that do not fail

_Written 2026-10-10. What the chat's tools promise, how it is checked, and what cannot be
promised._

## The problem

The owner's words: "the tools the chat makes do not fail, because a lot of them fail". The
causes, seen on the day: Kiwi's breaker (a 403 or 429 opens it for five minutes and every live
search in that window throws, so every live tool answered `{ error }`); a wild build that took
two minutes and showed "stopped before it finished" when the turn was interrupted; bare arrays
or objects with `undefined` fields that the model read as "nothing"; a city written with
diacritics or in lower case that a tool refused; a date in the past that was an error instead
of a correction.

## The rules (lib/agent-tools.ts)

1. **Every result carries `searched` and `source`.** `searched` is the Kiwi searches spent in
   this call (0 for a memo hit, a stored trip or static data). `source` is one of `live`
   (searched now), `memo` (the same search within the engine's memo window), `boards` (last
   night's boards), `memory` (the shared fare memory in Postgres), `stored` (a trip or plan in
   Blob), `data` (the static files), `feed`, `web`, `liteapi`, `foursquare`, `travelpayouts`,
   `model`, `none`. The system prompt tells the model to say which when it quotes a price.
2. **Live prices off means a fallback, not an error.** Before any live tool searches it asks
   `kiwiThrottled() || kiwiBudgetSpent()` (`liveOff`). When live is off, or when every search
   of a run was refused, the tool answers from what is known through `knownFares`: tonight's
   boards (`dealsFor`) filtered to the place and window, and the fare memory (`cheapestSeen`,
   `fareHistory`), under the note `live prices are rate-limited, this is from tonight's boards
   and the fare memory`. Per tool:
   - `find_getaways`, `reprice_route`: board deals and remembered fares for the place and dates.
   - `scan_cheapest`: a calendar from the memory's cheapest fare per month plus the boards,
     rows marked `remembered`.
   - `two_city_combos`: the neighbours with their ground leg, unpriced.
   - `wild_trip`: the same loop stored earlier (any age), else the undated version; else a note.
   - `long_stay`: not run at all (the engine has no search budget of its own and spends 16
     to 20); a plain note says why and what to ask next. A search refused mid-run leaves
     that base unpriced under a note.
   - `group_trip`: the windows everyone is free, unpriced.
   - `events_worth_travelling_for`: the events priced from the boards, the rest listed.
   - `cheapest_way`: a budget of 1 that Kiwi's gate refuses inside the process (or the engine
     skips while the breaker is open), so the route engine answers from the fare memory and
     the ground graph. The note is then the tool's own rate-limit sentence, decided from the
     tool's state before the run (`liveOff()`, or every search of the run refused), never the
     engine's: under a budget of one the engine's note for an empty answer says "no way
     found", when nothing was searched. The engine's detail stays in `considered` ("1 search
     not made while Kiwi throttles this address").
   A throw that is a throttle message is also caught in `safe()` and turned into a note, as
   the last net.
   **The turn's own budget is not a rate limit.** When it is only this turn's 120 searches
   that are spent, the fallback note is `TURN_NOTE` ("this turn's search budget is spent; ask
   again in a new message for live prices") and never `RATE_NOTE` or "in a few minutes"; the
   prompt tells the model the difference. `knownFares` takes a `turn` flag for this.
2b. **Only a search that left the process is charged and called live.** Kiwi's gate memoises
   a search for a day, so `reprice_route` and `cheapest_way` read `kiwiStats().today` before
   and after and report the delta as `searched`; a delta of 0 with a result is `source: memo`
   (`cheapest_way` also says so when the engine served its own hour-old answer). The engines
   that stamp `generatedAt` (`scan_cheapest`, `long_stay`, `group_trip`) are charged through
   `builtNow`, asked once per result. A remembered fare in a route answer is `source:
   memory`, read from `RouteResult.sources` (the engine lists `live`, `memory`, `ground`),
   and the leg built from it carries `RouteLeg.remembered`, which the compact leg line says
   as "(remembered fare)". The engine's budget is a ceiling, not part of its memo key: the
   same route asked again with a bigger budget (harder) extends the answer found instead of
   re-running it (the stored options appear at once, only new hubs are searched), so the
   engine's `searched` is cumulative on an extended answer while the turn is charged only
   the gate's delta.
3. **Never an empty object, never `undefined` fields.** Bare arrays became objects with
   `count` and the list; every "nothing found" has a `note` that says what was searched and
   what to try; optional fields are spread in only when present.
4. **Long builds report partial results, through the engines' own deadlines first.** Each
   long tool hands its engine a deadline ten seconds (`DEADLINE_MARGIN_MS`) before its own
   race fires, so the engine closes its answer and hands it back whole: `wild_trip` passes
   `deadline: Date.now() + WILD_BUILD_MS - 10_000` (`WildParams.deadline`) into `buildWild`
   and `buildWildVariants`, and past it the chain stops growing and the way home is searched
   from the stops found; `long_stay` passes `LongStayParams.deadline` and `group_trip`
   `GroupParams.deadline` (`LONG_BUILD_MS - 10_000`), and past it no further base or window
   is priced. The engines' answers then carry `partial: true` and their note ("2 bases not
   priced in time; ask again for the full list", "1 window not priced in time"), which the
   tool passes through as `partial: true` plus the note; a wild loop that came back after
   its deadline is marked `partial: true` with a note that it may be shorter than asked (the
   engine has no marker of its own yet; see the handoff). The race (`WILD_BUILD_MS`, 170 s,
   env `WILD_BUILD_MS`; `LONG_BUILD_MS`, 150 s) is the last resort: past it the wild build
   goes on in the background and is stored with its verdict, and the answer is the stored
   trip when one exists or a note saying to ask again in two minutes; ranked variants
   return the versions already stored; a long stay or group search past the race answers
   a note (the windows, for a group). A stored copy is named for what it is: the same loop
   (built for these dates) or the undated loop (built for no particular dates, its days not
   the ones asked), with `undated: true` and the key of the file it is really stored under
   (`month: "next"`, the literal `wildPath` writes for no month, so `plan_days` reads that
   file whatever month the app has selected). In the ranked answer past the race only the
   dated copies count as "N of M versions are ready"; undated ones are listed after them,
   marked, with their own key. A ranked answer is `partial` when any of its versions was
   closed at the deadline, not only the first (a fresh stored variant may rank above the
   one cut just now), and the note names the variant. The long-stay race note says what
   holds: the engine keeps no memo of a run cut short, only Kiwi's gate remembers the
   searches already made (a day), so the retry repeats the pricing but faster.
4b. **An engine's refusal is its sentence, as a note.** The engines refuse some requests in
   a plain sentence: `buildWild`'s "X is in Portugal, which is on your been list", "N nights
   are not enough to pass through ...", "unknown start airport ...", its throttle sentence
   (Kiwi's gate, passed up when every way in or the way home was refused),
   `LongStayInputError` ("region custom needs a countries list ..."), `GroupInputError`
   ("Every country of ... is on your been list"). The tools return these as `{ note }` with
   the sentence as is (`source: data`, `count: 0`, the trip key when there is one), never as
   `{ error }`, so the model repeats them to the traveller; `buildWildVariants` rethrows the
   first refusal when no variant built, and the ranked path catches it the same way. A
   throttle sentence is a rate limit and is answered with the stored copy when one exists,
   the sentence leading the note. The prompt says a sentence-shaped note is the engine's
   refusal: repeat it, fix the input or ask, never call the tool again unchanged.
4c. **A countries list means region `custom`.** Whenever `wild_trip` is given `countries`, the
   trip is keyed as region `custom` whatever region was named (the engine labels and tags
   such a trip by its countries, and `/api/wild` and `/api/plan` store it under `custom`),
   so the chat and the Wild tab find the same stored trip; the `key` the tool returns says
   `custom`, and the region input's description says so. `plan_days` takes that key as is,
   and when a key written back with the named region finds no trip it reads the `custom`
   path before saying nothing is stored.
5. **Places never throw.** `findCity` folds accents and case; a region label ("Southeast
   Asia") resolves to its key; a country name in a city field means its country. An unknown
   place answers a note with close matches from cities.json (`closeCities`: prefix, word
   inside the name, then names within two or three edits).
6. **Dates are corrected, not refused, and never guessed.** `parseDay` reads ISO,
   `2026-11-5`, `14/11/2026`, `14.11.2026`, `14 November 2026`, `Nov 14` (next occurrence),
   `today`, `tomorrow`, `next friday` (the coming one). Words are read only when a month name
   AND a day number are really there: `Date.parse` is never used, because V8 reads "this
   weekend 2026" as 1 January 2026 and the search would run on the wrong week with no note.
   "this weekend", "Christmas", "end of October", "late Nov 2026" are null, and the tool
   answers "not a date I can read". Every non-ISO input that was read is reported in
   `corrected` (the departure "next friday" read as 2026-10-16), as is a departure
   `cheapest_way` assumed (three weeks out). A past start moves to today, an end before the
   start becomes start plus a week. Only an unreadable date is `{ error }`.
7. **`cheapest_way`** wires `lib/route-finder.ts` (the route stream's engine) as a tool with
   a search budget of `min(12, what is left of the turn)`, or `min(24, left)` when the input
   has `harder: true` (the prompt sets it when the traveller says "search harder", "look
   harder", "exhaust", "every option"); 1 when live is off, which the gate refuses. It also
   passes `deadlineMs`: the engine's usual 90 s (150 s with `harder`), cut to what is left of
   the turn (`TURN_MS`, 270 s, env `CHAT_TURN_MS`) less the margin, floored at the engine's
   10 s, so the tool never outlasts the turn. A departure within `flex` days of today would
   start the window in the past; the engine searches from today and the tool says so in
   `corrected`, decided against the server's UTC day, the day the engine trims against (the
   browser's `ctx.today` may be a day off it, and the line would then name a day the engine
   did not search from, or fire when it did not trim). The compact answer lists kind, title, total, hours, stops, `nonstop` (the
   engine's flag: true only when no flight leg stops; kind `direct` means the nearest
   airports and may be a one-stop ticket), why, legs, urls, the cheapest and the fastest,
   `considered`, `placed` (`{ from, to }`: an end the engine could not put on the map is
   false, with an `unplaced` line, so the model never writes "from X" for it), and always
   the `depart`, `flex` and `nights` (null for one way) it priced. `source: memory` is read
   from `RouteResult.sources` and the leg line from `RouteLeg.remembered` (both are part of
   the engine's type; the earlier regex fallbacks over `considered` and the why are gone).
   With no `from`, the traveller's place is sent by name when the engine knows it, else as
   lat,lon with the name put back afterwards on the labels, the titles, the why lines and
   the legs of `raw` (from, fromName, to, toName, the way back included), so neither the
   model nor a card or globe path that reads raw legs ever gets coordinates as a place; the
   compact fields are read from the relabelled raw, so both say the same. The chat draws the options as cards (the
   card says "nonstop" from the flag, else the stop count) with a "Show the route" button
   that dispatches `atlas:route` `{ from, to, depart, flex, nights, oneWay }` so the globe
   redraws the same question.
8. **The chip never ticks an empty answer.** `plain()` carries `count: 0`, and the chat treats
   a result with a note and nothing to show (no count, no non-empty list, no verdict, no
   trip) as noted: an amber chip with the note, not a green tick with the note hidden in a
   tooltip.
9. **The engines' new inputs are passed through, bounded.** `wild_trip`: `countries` and
   `prefer` by name or code, region `custom` (needs countries), nights 5 to 90,
   `mustInclude`, `maxFlightHours` 1 to 40, `startFrom` (IATA, 3), `wishes` (300 chars),
   `nightsPerStopMax`; all go into `customKey`'s extras so `plan_days` finds the trip.
   `long_stay`: `mustInclude` and `wishes`; an input the engine refuses
   (`LongStayInputError`) is its plain sentence. `group_trip`: `budgetPerPerson`, `where` as
   names or a comma list; the engine's `dropped`, `note` and `where` are passed through.
   `events_worth_travelling_for`: `kinds` is free text (a kind, a word of an event's name, a
   city, a country code).

## The harness (scripts/check-tools.ts)

```
node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/check-tools.ts
node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/check-tools.ts --live-cap=0
node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/check-tools.ts --long-stay
node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/check-tools.ts --only=command,dispatch
node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/check-tools.ts --only=itinerary --itin-stub
```

`--only=` picks sections: `command` (parseCommand on 55 typed lines against a fixed Saturday,
2026-10-10; every list must end with exactly one ask), `dispatch` (the details the chat puts
on the UI bus, from fixed inputs), `itinerary` (make_itinerary: two stops by name, nothing to
plan from, an unknown place, `last_route` replayed from history and from compact rows; with
`--itin-stub` the model key is hidden for the call so the engine's guide-only path writes the
days, no Bedrock), `tools` (the live table below). All but `tools` spend zero Kiwi searches.

It builds `atlasTools` for the Brasov context (GHV, SBZ, OTP, home RO, origin 45.657/25.601,
today) and calls every tool once: the stored, memoised and static ones first (no search
leaves the process), then the live ones with the smallest inputs, cheapest first, each
checked against a live cap (12 by default) before the call; `wild_trip` only when a trip is
stored and fresh for the context, `plan_days` only when its plan is stored, `long_stay` only
with `--long-stay` (about 16 searches). Then: the same `reprice_route` again (must be a memo
hit: searched 0, source memo, nothing sent); every live tool with the turn's budget set to
spent (nothing may leave the process, and the note must not call it a rate limit); nineteen
`parseDay` cases against a fixed Saturday (the words the model writes, the vague ones null);
a few edge inputs (a misspelt city, an unknown country, a month "2026-13", a check-out
before check-in, a region by its label) that must answer a note or a plain error; and a few
loose inputs (lower case, a leading word) that must resolve.

Added on 2026-10-10 (the deadlines round): a dated `cheapest_way` with `depart` = today + 1
and `flex` 2, whose window would start yesterday (one live search; `corrected` must say it
was searched from today, and `depart` and `flex` must come back as given); a `wild_trip`
under the named region `sea` with `countries` Vietnam and Thailand on the budget-spent path
(0 searches; the `key` must say region `custom`, with the codes in `custom`); a `long_stay`
with region `custom` and no countries (the engine's `LongStayInputError` sentence must come
back as a note, never `{ error }`); and the parameters the tools hand their engines, read
through `AgentContext.trace`, a hook the harness sets that records the parameters and
throws, which `safe()` turns into `{ error }` before any search leaves: `cheapest_way`
builds `budget` 12 (24 with `harder`) and a `deadlineMs` of 90 s (150 s with `harder`) and
keeps a tomorrow departure as given; `wild_trip` with countries calls `buildWild` with
region `custom`, the codes and a `deadline` 160 s out; `wild_trip` with `variants` 2 calls
`buildWildVariants` with the same deadline; `long_stay` and `group_trip` pass a `deadline`
140 s out. These parameter cases run on a fresh `atlasTools(ctx)` instance (a new turn
clock, the way the chat route makes one per request): `cheapest_way`'s `deadlineMs` counts
down from the moment its instance was made, and the live checks before this section can
run for minutes, which would fail the harder verdict (150 s) although the tool is right.
The cheapest_way case that spends the cap is the dated one; the plain one runs after it
when searches are left. The dated case runs with the origin label "Nowhere Hamlet" (at
Brasov's coordinates, a name the engine cannot place, so the tool sends lat,lon) and a
verdict reads the whole answer, `raw` included, for any "45.66, 25.60" label: there must
be none, and `from` must be the name.

Not in the harness: the live-off path of `cheapest_way` (the breaker open, or the daily
budget spent) cannot be forced from outside the gate (no test hook opens the breaker and the
daily budget floors at 100), so that note is checked by reading, and by the next day Kiwi
throttles the address.

A row fails when the tool threw, answered nothing, answered `{ error }` for a valid input,
answered an empty object, or left an `undefined` field; the script exits 1 then. The table
shows ms, Kiwi searches spent (from `kiwiStats().today`, so memo hits count 0), `source` and
the note. The last line gives the run's total searches and the breaker state.

Runs on 2026-10-10 (the deadlines round, Kiwi open): `--live-cap=0`: `73 tools, 0 failed;
Kiwi searches sent this run: 0 (0 failed, 0 held by the breaker); turn budget used: 0;
breaker closed` (every stored, dry and refusal case passed with nothing sent). `--live-cap=6`:
reprice 1, find_getaways 1, group 4, all ok, the memo probe, the budget-spent probes, the
key, refusal and parameter cases ok (the dated route was skipped under the cap, and the
session's own output trimming cut the final line). `--live-cap=2`, after the dated route
was moved ahead of the plain one: `74 tools, 0 failed; Kiwi searches sent this run: 2 (0
failed, 0 held by the breaker); turn budget used: 2; breaker closed` (reprice 1, the dated
route 1: `corrected` "the window around 2026-10-11 with 2 days flex would start before
today; searched from today ..."). Eight live searches in all.

Run on 2026-10-10 after the fixes round (`--live-cap=6`, Kiwi open): `73 tools, 0 failed;
Kiwi searches sent this run: 6 (0 failed, 0 held by the breaker); turn budget used: 6;
breaker closed` (reprice 1, find_getaways 1, group 4; scan from the memory 0; the two
cheapest_way cases and combos skipped under the cap; the memo probe, the eight budget-spent
probes, the key, refusal and parameter cases, the nineteen date cases all passed). The
dated cheapest_way case was then run on its own with the "Nowhere Hamlet" label and a turn
budget of 1: 1 live search, `corrected` "the window around 2026-10-11 with 2 days flex
would start before today; searched from today (2026-10-10) to 2026-10-13 instead" (the
engine's own considered line agrees: "The window starts today (2026-10-10), not
2026-10-09."), `from` "Nowhere Hamlet", raw legs "Nowhere Hamlet/Nowhere Hamlet | OTP/
Bucharest | VIE/Vienna | ... | Nowhere Hamlet/Nowhere Hamlet", no coordinate label left.
Seven live searches in all.

Run on 2026-10-10 (Kiwi open): 34 rows, 0 failed, 7 live searches (scan from memory 0,
reprice 1, find_getaways 1, group 4, cheapest_way 1; combos and long stay skipped under the
cap). The first run found three real leaks (`hotel_deals` and `ask` with `undefined` fields, a
stored wild trip with `judge: undefined`), fixed the same day.

Run on 2026-10-10 after the review (`--live-cap=8`, Kiwi open): 62 rows, 0 failed, 7 live
searches sent (reprice 1, find_getaways 1, group 4, cheapest_way 1; scan from the memory,
combos and long stay skipped under the cap); the memo probe, the eight budget-spent probes
and the nineteen date cases all passed with nothing sent.

## The review of 2026-10-10 and what changed

- `parseDay` sent "next friday", "tomorrow", "this weekend", "Christmas", "ASAP" to 1 January
  next year (V8's lenient `Date.parse` kept only the appended year) and the search ran on the
  wrong dates with no note. Now words need a month name and a day number, relative days are
  read explicitly, and every reading is in `corrected`.
- `long_stay` computed the turn's `exhausted()` and ignored it, spending up to 20 searches on
  a spent turn; it now answers a note before running, and the harness estimate is 16.
- A note-only result showed a green tick with the note in the tooltip; now amber with the note.
- "Show the route" redrew a one-way answer as a return and a default departure as 14 days out
  instead of the engine's 21; the tool now always returns the `depart` it priced and the
  button sends `oneWay`.
- `reprice_route` charged the turn and said live for a memo hit; `cheapest_way` inherited it.
- `cheapest_way` without `from` labelled the origin "45.66, 25.60"; now the place name.
- A route answered only from the fare memory said `source: data`; now `memory`.
- The turn-budget fallback note said "rate-limited ... try again in a few minutes"; now it
  says a new message searches at once.

## Itineraries, the command line and the UI bus (added 2026-10-10)

The owner's verdict on the Trips tab's "Purpose" and "A to B" modes: they are capabilities,
not tabs. The chat's part of that:

- **`make_itinerary`** turns what the thread showed into a day-by-day itinerary through
  `generateItinerary` (lib/itinerary-server.ts). Two ways in: `from: last_route | last_deal |
  last_wild` (with `option`, 1 = the first shown; there is no chat tool for short loops, so
  no `last_loop`) or `stops` by name with `start`
  and `origin` (through `skeletonFromStops`). "The latest" lives in `AgentContext.recent`, a
  per-request map: the chat route replays the thread's history through `rememberOutput`
  before the raw payloads are slimmed, and every route, deal or wild tool of the turn
  replaces its entry. A restored thread (raw payloads gone) still works: the compact rows are
  kept and planned by names; a one-way route stays one way (no return leg), and an option
  whose tickets cannot be rebuilt from the rows (a train to a hub, an open-jaw) is named in
  the note as planned by place names. No Kiwi search; the engine's clock ends eight seconds before
  the tool's (`CHAT_ITINERARY_MS`, default 150 s, never past the turn), and a run past it
  answers with the days written so far as a `partial` itinerary; its card opens the view
  from the skeleton, so the whole trip is written there. Errors of input (an unknown
  place, nothing shown yet) are notes. The model reads the days in short; the `skeleton` and
  the whole itinerary (`raw`) go only to the browser, which opens the itinerary view with
  them. Saving is never a tool: it is the traveller's click.
- **The system prompt** (`chatSystem` in lib/agent-tools.ts, shared with the terminal CLI)
  says: two places named means `cheapest_way`; "what is on" means
  `events_worth_travelling_for` and saying which events are within reach; after a route, deals
  or a wild loop offer an itinerary once; "plan the days" means `make_itinerary`; mention the "/"
  command line once in a thread.
- **The chat panel** draws a `cheapest_way` result the moment it arrives (`atlas:route-result`,
  no second search); every route option, deal card, wild trip and event has "Make an
  itinerary" (a skeleton from lib/itinerary.ts, `atlas:itinerary`); an event has "Show on the
  map" (`atlas:command` with an `/events` line) and "Get there" (`atlas:route`); a written
  itinerary is a short timeline with "Open the itinerary". The detail builders live in
  lib/chat-widgets.ts so the harness checks their shapes.
- **The command line** (lib/command.ts) is pure and runs in the browser and in the terminal
  (`scripts/atlas.ts`, docs/cli.md).

## The graph walk in the chat, the command line and the terminal (added 2026-10-10, evening)

The owner, after a chat priced seven legs one by one with `reprice_route` (about forty
searches): "it does not think like me: I would have done Brasov-Warsaw plane, then
Warsaw-Gdansk train, then Gdansk to another city and that back to Brasov or Sibiu or
Otopeni; how I do it manually is use the Skyscanner explore from that location".

- **`walk_trips`** (lib/agent-tools.ts) runs `walkTrips` (lib/graph-walk.ts) once: the
  traveller's point, airports and home from the context (or `origin`, a named city with its
  own nearest airports), the window read with `parseDay` and defaulted by `walkWindow`
  (lib/chat-widgets.ts, shared with the command line: a week out, 5 to 6 nights, a week of
  slack, each assumption a `corrected` line), `nightsPerStop` (a number, a range with
  `nightsPerStopMax`, or "2-3"), `maxStops` (3), `beam` (2, the owner's case),
  `mustInclude`, `avoid` (codes, names, `like:DE`, group words), `prefer`, `countries`,
  `style` ("unique"), the Been filter as everywhere. Budget: twelve searches at most, never
  more than the turn has left; the engine's clock is cut to the turn. The answer: the loops
  (the route as a line, "Brasov, plane, Warsaw, train, Gdansk, plane, Bucharest", stops with
  nights, legs with kind, price, minutes, source and the booking url, total, hours, why),
  `considered`, `searched` (what left the process now), `source`, plus `raw` (the
  WalkResult) and `params` (the /api/walk query) for the browser only (`toModelOutput`
  strips both).
- **It streams.** `execute` is an async generator: every progress line and every closed loop
  of the engine is yielded as a preliminary output (`{ running: true, progress, loops, edges,
  searched }`), which the AI SDK sends to the browser as a preliminary tool output; the last
  yield is the answer. The chat panel shows the latest line on the tool's chip with the
  seconds, and treats a preliminary part as still running (a thread stopped mid-walk is
  settled to "stopped before it finished", never replayed to the model as an answer). The
  terminal and the harness drain the generator (`drain`) and print the lines.
- **A spent budget is never a refusal.** `walk_trips` and `cheapest_way` with the turn's
  budget spent run their engine at budget 0 (the fare memory, the boards, the ground graph)
  and say `this turn's search budget is spent ...; live prices were not searched`; with
  live prices off (breaker, daily budget) the note is the rate-limit sentence instead.
- **The prompt**: any trip with more than one city, a loop, "go from X and come back from
  Y", "plane then train", "cheapest loop", or a chain the traveller writes out is ONE
  walk_trips call, never legs priced one by one; "not Germany" is `avoid: [DE]`, "countries
  like Germany" is `like:DE`; "unique", "not touristy", "hidden gems" is style unique; the
  answer explains the best loop in his terms (the cheapest edge out of each stop, where a
  train or coach beat a flight, nights per stop, a booking link per flight). wild_trip keeps
  far regions and loops of weeks; reprice_route keeps one named leg.
- **The chat panel** draws a walk the moment it arrives (`atlas:walk-result` with the raw
  result and the query), shows each loop as a card (the route as hops with icons, the total,
  nights per stop, why lines, the legs folded with a booking link per flight), "Show on the
  map" (`atlas:walk-result` with that loop first; a restored thread without the raw result
  sends `atlas:walk` with the stored query at budget 0, see the review fixes below) and "Make an
  itinerary" (`skeletonFromWalk`, `atlas:itinerary`; restored: asked of the agent).
- **The command line** (lib/command.ts) has a `walk` kind: `{ kind: "walk"; origin?; from?;
  to?; minNights?; maxNights?; nightsPerStop?: number | [number, number]; maxStops?;
  mustInclude?: string[]; style?; avoid?: string[]; label }`. A far region or weeks overland
  stays Wild. The terminal runs it through walk_trips and prints a tree (docs/cli.md).
- **CHAT_TURN_SEARCHES** (env, optional) lowers the searches one chat turn may spend.

Tested 2026-10-10 (10 Kiwi searches in all): the harness's command (19 walk lines among
them), dispatch and walk sections, 124 checks, 0 failed after one fix of its own regex; the
budget-0 walk sent nothing and closed Naples → Tirana from the fare memory; one live walk at
a cap of 2. `atlas loop from Brasov 20 to 30 Oct 5 to 6 nights 2 nights a stop --live-cap 3`
closed Naples → Rome at 123 euro (fly GHV to NAP 17, coach to Rome, FCO to OTP 74) with 3
searches. The owner's sentence through `atlas ask --live-cap 5` (the chat's prompt and tools)
called walk_trips once (and price_insight, no search) and answered Gdańsk → Warsaw → Tirana
at about 189 euro. Not done: the same sentence through `curl POST /api/chat` (the only dev
server running belonged to another session and has no turn cap, so a walk there could spend
twelve more searches, past the test's limit of ten).

### Review fixes (2026-10-10, night)

- **The command line reads the owner's chain.** An A-B pair is two places (`Brasov-Warsaw
  plane`, `Brasov - Warsaw`; `Cluj-Napoca` stays one), so his sentence is a loop from Brasov
  through Warsaw and Gdansk. A chain that begins with a hop (`fly to Warsaw then train to
  Gdansk`, `Warsaw by plane then ...`) has no origin: it starts where the traveller is, since
  a loop that started in Warsaw could never stop in Poland. `come back from X`, `with X`,
  `via X` and `X and Y` are stops; `back to Brasov or Sibiu` is the way home. `not by plane`
  is no avoid entry, `not via Munich` is Munich, `the dach countries` is `dach`, and
  `balkans`, `iberia`, `germanic`, `british isles` are group words too. `loop through Poland
  6 days` is a walk with `countries: ["Poland"]` (a new optional field of the walk command);
  two weeks or more, or a country outside Europe, stays Wild.
- **walk_trips keeps the traveller's home country for a named start.** Before, a start in
  Warsaw made Poland the home country and banned Gdansk. A city to pass through that lies in
  the home country now gets a plain note before any search; the start itself is dropped from
  `mustInclude`. With the turn's budget spent, a request the engine refuses (nights that do
  not fit, an unknown place) shows the engine's reason, not "ask again".
- **A chat walk is drawn while it runs.** Each preliminary output carries the walk's newest
  nodes, edges and loops (`live: { at, lines }`, each batch sent twice so a render that folds
  two updates loses nothing) and the query; ChatPanel sends the ones not yet sent as
  `atlas:walk-live { id, params?, lines }` (lib/chat-widgets.ts). The globe has to listen for
  it (the shell's part, in the handoff): until it does, the chat walk appears when it ends.
- **"Show on the map" on a restored thread** reruns the walk at budget 0 (no memo exists for
  it: the chat's walk never went through /api/walk) and rests once the window's first day
  has passed.
- **walkWindow** writes its notes from the window it really searched; an end in the past is
  dropped, not swapped.

## The trip style in the chat, the command line and the terminal (added 2026-10-12)

The owner: "I want the wild trips and stuff to be like 2-3 days per location max, can I make
these settings, does it work with Dijkstra and all". Before, a 21-night Wild loop stayed 3 to
6 nights a stop, the walk 2, and nothing carried the traveller's taste from one builder to
the next. Now one setting does (lib/prefs.ts, the prefs stream: `Prefs`, `DEFAULT_PREFS` 2 to
3 nights a place, kept in the browser, the `atlas:prefs` event), and the chat honours it:

- **The context carries it.** ChatPanel sends `context.prefs` with every turn: the shell's,
  else the one saved in this browser (`loadPrefs`), kept current by `atlas:prefs`. The route
  believes it field by field (`chatPrefs` in lib/agent-tools.ts over `cleanPrefs`: nights 1 to
  14 with the least first, each choice from its list, the longest flight 1 to 40 h, avoid
  words the walk cannot read dropped, since one would refuse every walk). No object sent is
  no style: the tools fall back to `DEFAULT_PREFS`. The panel shows the style in one line above
  the input with a Change button (`atlas:open-prefs`, which the top bar opens).
- **The prompt states it** (`prefsLine`) and says the rule: the style is every tool's default,
  the tools apply it on their own when the input leaves it out, and a message that says
  otherwise wins for that trip only ("3 to 4 nights in each this time" is nightsPerStop 3,
  nightsPerStopMax 4 for that search). To change it for good: the Trip style button or /style.
- **The tools take their defaults from it**, each answer saying which in `tripStyle`:
  `walk_trips` (nights a place, tradeoff, `style: "unique"` for that taste, the avoid list
  added to the message's own, `[]` lifting it once; `ground: ok | prefer | none` with the
  style's "no trains or coaches" as none; the longest flight), and its stops scale with the
  nights (`ceil(maxNights / least nights a place)`, up to 16) and its budget with the stops
  (2 a stop plus 2, at least 12, at most 40, never past the turn), its clock ten seconds a
  stop past three (150 s at most). `wild_trip` builds with the graph walk by default
  (`wildByWalk`, lib/wild-walk.ts, the wild stream: a targeted search into the region, the
  cheapest next hops, trains and coaches from the Dijkstra over the ground graph) at the
  style's nights a place, tradeoff, longest flight, taste (as wishes) and avoid words;
  `engine: "classic"` is the old chain (at the same nights a place, as the Wild tab's
  classic toggle sends them, so the two key the same trip) and variants above 1 are always
  classic. A style that cannot fill the nights in 16 stops (60 nights at 3) leaves the
  engine's longer stays and says so. The stored key gets `engineKeySuffix` (`-walk`, the
  avoided countries, `-g0` for flights only), the scheme /api/wild uses, except ranked
  variants, which lib/wild-variants.ts stores under `customKey` alone. The leftover of the turn
  is handed to the walk only when it is below the walk's own budget for the nights (2 a stop
  plus 2, the stops being the nights plus one at the fewest nights a place); such a short walk
  is served but not stored. Taste unique adds the wishes `unique places and hidden gems over
  the big hubs` (`UNIQUE_WISHES`), joined with ", ", word for word what /api/wild adds, so the
  wishes hash in the key matches the Wild tab's. `cheapest_way` caps the trip at the longest
  flight plus three hours door to door and says which option to `lead` with by the tradeoff;
  `make_itinerary` plans at the style's pace; `find_getaways` (which also drops deals in an
  avoided country) and `group_trip` take its nights only when the traveller changed the
  nights a place themselves (a changed tradeoff or avoid list leaves them alone), a getaway
  being one place.
- **The command line reads the same words** (`readTripStyle` in lib/command.ts, before the
  dates and the stay): `2-3 nights per place`, `2 to 3 days each`, `max 3 nights a city`, the
  owner's `2-3 days per location max`, `slow pace` (3 to 4) and `packed` (1 to 2) when no
  nights are typed, `only trains between cities` (ground hops to 8 h), `flights only`,
  `unique`. The walk command gains `pace` and `ground`, the wild command `nightsPerStop`,
  `style`, `pace` and `ground`; `ground` is minutes (480 for trains between places, 0 for
  flights only) because the shell copies the walk command's fields into /api/walk as they are.
  The style words are taken out of the line only for loops, wild lines, nights a place, a pace
  or trains (`Brasov to Vienna by train only` is a route; `cheap flights only to Spain in
  november` stays getaways). `/style` (`/prefs`, `/settings`, "trip style") is the kind
  `prefs` and `/help` ("help", "how does this work") the kind `help`, only for the words the
  command bar opens by itself, because the shell's runCommand has no case for either kind yet;
  "what can you do" and "open my trip style" are questions for the chat. `walkCommandQuery`
  takes the style as its last argument.
- **The terminal** takes the style as flags over the same defaults (`--nights-per-place 2-3
  --taste unique --tradeoff price --avoid dach --pace --max-flight-hours --no-ground`), `atlas
  style` prints it, `atlas wild sea 14 nights` builds with the walk (`--engine classic` for the
  old chain) and checks its cost (about 2 a stop plus 4) against the cap.

Tested 2026-10-12 with no Kiwi search: the harness's command section (21 new lines),
dispatch (the style filling a walk query, the line winning) and the new prefs section (the
clamps, the prompt, the defaults reaching walk_trips, wild_trip on both engines,
cheapest_way, group_trip and find_getaways, all through the trace or a spent budget). The
route itself was posted in-process with `CHAT_TURN_SEARCHES=0` and `context.prefs` 2 to 3:
"two weeks in the Balkans, cheapest" called wild_trip (the walk engine, the key
`n2-3...-walk`, `tripStyle: 2 to 3 nights a place`), a 10 night loop called walk_trips with
`nightsPerStop 2-3` and 5 stops. Not done through curl: the one dev server allowed per folder
belonged to another session, with no turn cap.

## The owner's conversation (2026-10-12)

The owner's words: "look how bad it is, the whole experience; look at a conversation, it did
not help me at all, a lot of tools failed". He had found Brasov to Warsaw on 24 October and
asked how to come back, preferring Gdansk. What went wrong, and what each now does:

1. **No "how do I get back from here".** walk_trips re-planned his way out (Bucharest to
   Gdansk first) and its way home was a 9 h one-stop at 82 euro on the 29th, while a direct
   Ryanair Gdansk to Otopeni on the 31st cost 32 and was found only after he said "direct".
   **way_home** (new): from a city, town or airport, over a window of days (default eight,
   at most fourteen), one Kiwi one-way search from the place's own airports and one from the
   airports a train or coach reaches within three hours (route-finder's `gatewaysFor`), to
   every airport of his home country within six hours of him (`countryAirports` and
   lib/pairs.ts's `HOME_MAX_MIN`, timed on the ground graph). It answers a calendar (per day
   the cheapest and the cheapest direct, with times, airline and link), the best direct, the
   cheapest and the cheapest door to door, and the ground leg from each home airport to his
   door. Never more searches than the turn has left; with live prices off it answers the
   fare memory's cheapest one-way under the usual note. The prompt: when the traveller has
   a chosen or booked flight out, keep it as given, call way_home from the city they prefer,
   show the direct options first.
2. **walk_trips takes the traveller's own flight.** `fixedOut: { from, to, date, price? }`
   (lib/graph-walk.ts `WalkParams.fixedOut`): the walk starts at the landing city on that
   day, at depth 1, with that leg as given (source `given`, priced when a price is passed,
   otherwise unpriced and the loop says so). No search is spent on it and no loop replaces it.
3. **Towns.** Every place argument (walk mustInclude and origin, cheapest_way, way_home,
   ground_reach, events, sights, events_near) is read by `findPlace`: cities.json, then the
   GeoNames towns file and airport names (route-finder's `resolvePlace`), then a ground graph
   station by its name or town (Hallstatt is only its lake pier there), accents folded. A town
   without an airport is a walk stop reached by ground only (`WalkParams.towns`; flights never
   land there or leave from there). Torun works: the walk goes Warsaw, train to Torun, coach to
   Gdansk, fly home.
4. **Events.** events_worth_travelling_for takes `city` (up to three) and dates for what is on
   locally: the city's open feed when lib/events/sources.ts has one, the curated events within
   60 km, else ONE Tavily search "what's on in <city> <dates>" parsed into dated items with
   links (`dateInText` reads ISO, 24.10.2026, "24 October", "Oct 24th"), each marked "from the
   web, check before buying". A city passed as a kind becomes the city, and the answer says so.
5. **Fare memory.** price_insight compares like with like (`fareVerdict` in lib/insights.ts):
   the same city pair (every airport of each side), the same kind (one-way, or a return within
   two nights of the fare's), departures within seven days of the fare's own day, sightings of
   the last 30 days, one sample per departure day per sighting day. It says "based on N fares";
   under five it says "not enough history", never great or high. A per-request memo keeps the
   same route's answer the same within a turn.
6. **Itinerary costs.** Every part is in the total: a leg without a price is estimated by its
   distance (a flight at 25 euro plus 5 cents a km, the ground at 10 cents a km); the room is
   LiteAPI's cheapest decent hotel at each stop when the production key is set (one lookup a
   stop, kept a day; it counts against the LiteAPI cap in lib/liteapi.ts), else the World Bank
   share; food and activities are estimates. `costs.note` says which parts are estimates. A
   build cut short by time shows no figure a day. The model calls in itinerary-server, judge
   and plan pass `allowUsage("model_call")` first; past the cap the days come from the guides,
   the trip ships unjudged, no plan is written. The chat route asks `chatRateLimit(ip)` (30
   turns an hour) and `allowUsage("chat_turn")` (the site's day) before the model runs.
7. **Fewer, faster calls.** At most two web searches a turn in all (web_search refuses a third
   with a note; the events tool makes at most one per city). Every `{ error }` ends with
   "next:" and the one thing to do. A coach between two cities of a country whose railway the
   ground graph lacks carries `trainHint` (the countries come from the graph's own feed ids,
   so the Polish feed added the same day turned Warsaw to Gdansk into a 2.6 h train).

Tested: the harness's new `owner` section (zero Kiwi searches) and the full harness at
`--live-cap=0`; the conversation itself replayed through POST /api/chat on the dev server,
four turns, at most twelve live Kiwi searches across the replay (a dev-only header,
`x-atlas-turn-searches`, lowers a turn's cap; production ignores it). Result: turn 1 called way_home (Gdansk, 27 Oct to 3 Nov, 2 searches) and led with the direct Ryanair Gdansk to Otopeni on 31 Oct at 32 euro, the fare memory saying great based on 10 fares; turn 2 the same with direct_only (a memo hit, 0 searches); turn 3 make_itinerary (3 nights Warsaw, 4 Gdansk, hotels from LiteAPI, every part in the total) and hotels_near twice; turn 4 walk_trips with fixedOut through Torun (train Warsaw to Torun, coach to Gdansk, the 32 euro flight home; 2 searches) and the events of Warsaw, Torun and Gdansk (two web searches, the third city told so). No tool failed; 4 live Kiwi searches in all; the harness at --live-cap=0: 297 rows, 0 failed.

### Review fixes (2026-10-12, evening)

A review of the owner's-conversation fixes found that several of his failures could come back. What changed:

1. **price_insight judges every price.** The per-turn memo keeps only the comparison (typical, lowest, samples).
   Each call then judges its own price with `verdictFor`. Before, the second fare on the same route and day got
   the first fare's verdict: the direct at 32 euro and the one-stop at 150 were both "great". The chip says
   "usually 65 euro, based on 10 fares" when only the price was missing, not "no fare history".
2. **way_home finds the direct.** One search to every home airport returns the cheapest 15 fares of the window,
   and on a busy route those are all one-stop. When a direct is asked for, none came back, or most days are
   empty, the same window is searched again one home airport at a time, large airports first: up to 4 more
   searches with direct_only, 2 otherwise, within the turn's budget. An empty day says "not among the cheapest
   fares found", never "no flight". Live, Gdansk 27 Oct to 3 Nov, direct only, 6 searches: GDN to OTP Ryanair
   at 99 on the 30th, 32 on the 31st and 52 on 2 Nov.
3. **No unsafe airports.** A town's airports (airportsAround) and way_home's train or coach airports drop any
   airport in a country under a travel warning, unless the place is in that country. Sopot no longer lists
   Kaliningrad.
4. **Towns in itineraries, and the fares already found.** `skeletonFromStops` takes a `resolve` for names that
   cities.json lacks (the chat passes its findPlace), so Warsaw, Torun, Gdansk becomes an itinerary.
   make_itinerary prices the unpriced legs with the fares this conversation already found: way_home's days
   and a walk's legs are remembered as known fares, and the model can pass `fares` for the traveller's own
   flight. It also plans `from: "last_walk"`. A leg with no known fare is still estimated, and the note says
   how many legs were priced from the thread.
5. **The walk's map params.** The params the browser keeps carry town names, not the walk's internal codes
   (T-torun), and a walk with the traveller's own flight or a town is marked `mapRerun: false`, so a restored
   thread never re-runs it through /api/walk without the flight (the button rests with a line saying why).
   The walk's tool wrapper stays an async generator, so this turn's walk is remembered for make_itinerary.
6. **Event words stay kinds.** "Marathon" and "Christmas" are never read as places (Marathon, Florida;
   Christmas Island). A word becomes a city only when it names a city with airports, or a town within 300 km
   of a city of the same request (Torun beside Warsaw and Gdansk). The events tool makes ONE web search for
   all the cities of a trip whose feed has little, and gives each page to the city it names. Dates in web text
   now read ranges that began before the window ("20 to 25 October") and "26.10." without a year.
7. **Hotel quotes.** A LiteAPI miss (the daily cap, an error) is kept five minutes, not a day; a price is kept
   a day. A one-adult room is no longer divided by the number of travellers.
8. **The chat's size.** The newest user message is refused past 4,000 characters (413, a plain line; the
   input box stops there). Older user messages are cut at 4,000, and the history the model reads is kept
   under 60 KB, oldest turns first.

Tested: the harness's `owner` section, 17 rows, 0 failed, 0 Kiwi searches; `--owner-live` (the way home
above), 6 Kiwi searches; every section but the live table at `--live-cap=0 --itin-stub`, 223 rows, 0 failed; POST /api/chat
with a 5,000-character message answered 413.

## What cannot be guaranteed

- **Kiwi's throttle.** The public search has no key, no SLA and no published terms. After a
  403 the address is blocked for minutes; the breaker keeps the site from making it worse,
  and every tool now answers from what is known, but a traveller asking for a place nobody
  searched before gets a note, not a price, until the breaker closes. On Vercel every
  instance has its own breaker and memo, so one instance may be blocked while another is not.
- **The fare memory's coverage.** It holds what anyone searched in the last days; a new route
  has no memory until someone scans it.
- **Time.** A wild build is 40 to 60 searches and one to two minutes; the chat route allows
  300 s. The time cap answers with the stored trip or a note; the rest keeps building in the
  background only while the function instance lives (on Vercel, a Fluid instance keeps
  running after the response, but that is not a promise).
- **The model's own behaviour.** The prompt says what to do with a note; the model may still
  retry a tool. `stopWhen` bounds a turn at ten steps.
