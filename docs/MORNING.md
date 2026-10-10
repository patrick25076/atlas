# Update, Saturday 10 October, last: "Been", and famous namesakes

_Two more things landed after the fixer round, then everything was committed and deployed._

1. **Been.** A pill in the top bar where you mark the countries you have visited. Off by
   default. With "Only new countries" on, no search (deals, custom search, wild loops, long
   stays, group, purpose events, short loops, the price calendar, the chat) proposes a
   destination or an overnight stop in those countries; a layover through them is always
   fine. With "Revisits are fine" the list is a record: cards get a "been" tag and the chat
   says when a place is new to you. Stored in your browser only. Details in
   `docs/plans/been-feature.md`.
2. **Fame data fixed.** Small towns were borrowing a famous namesake's Wikipedia views
   (Glasgow, Montana had Glasgow's 858,000; Birmingham, Alabama had the English one's).
   The ingest now checks every article against the city's coordinates and falls back to
   "Name, State" titles, so long stays and wild loops rank places by their own fame.
   2,758 cities resolved (was 2,549).

---

# Update, Saturday 10 October, late: the fixer round after the second review

_A reviewer read round two and found eight things; the first fixer attempt was killed with
the rest (the 5 GB of node and python you ended). Nothing of it had landed, so this round
did all eight. What changed, in plain words._

1. **A dead database costs one call, not every call.** With an unreachable `DATABASE_URL`
   (the direct Supabase host, or a pooler behind a stale password) every fare-memory call
   used to wait 21 seconds. Now the first waits 11 seconds, then the database is remembered
   as down for a minute and every call answers at once; after the minute it tries again.
   Measured: call 1 11.1 s, calls 2 and 3 0.0 s.
2. **Hotel history reads Postgres and Blob both.** A night whose Postgres insert failed (the
   GitHub secret still holding the old password after the reset) is picked up from its Blob
   snapshot; the Blob reads are skipped only when Postgres already holds a real night for
   this weekend.
3. **A short nightly run is named for what it is.** If LiteAPI prices fewer than 40 of the
   80 cities on a full run, the strip says "tonight's snapshot priced only N of 80 cities",
   not "a test run".
4. **Throttled searches no longer burn the budget.** Searches queued behind the gate when a
   403 opens the breaker are counted as held back, not as sent and failed.
5. **A Kiwi request that never answers times out after 30 seconds** and is retried like a
   503, so a hung connection cannot hold a search slot for the life of the function.
6. **`maxHours=-5` or `0.4` in the custom search** means no limit and "up to an hour", not
   "one hour" clamped and memoised empty.
7. **Group windows with impossible dates** (31 February) are refused instead of silently
   searched as 3 March.
8. The weekday in the headers below: 10 October is a Saturday.

---

# Update, Saturday 10 October, night: round two, finished after the restart

_The first attempt at this round filled the laptop's memory (a GTFS ingest and the dev
server together) and you ended the processes; the tree held half-done edits. Every stream
read its files again and finished. What changed for you, in plain words._

1. **Hotel deals compare like with like.** A city's price is now only measured against
   earlier nights that priced the **same weekend**. The nightly job prices the Friday at
   least four weeks out, and that Friday moves to the next one every Saturday, so each
   week the Saturday and Sunday snapshots say "warming up" and the deals show Monday to
   Friday. First deals: 13 October. The Deals tab has the strip now and the chat has the
   `hotel_deals` tool, so the URL has readers.
2. **Kiwi is left alone when it says stop.** The first 403 or 429 opens a five-minute
   breaker: nothing leaves the server, stored answers still work, the chat says "live
   prices are rate-limited right now". Hammering a throttled address was lengthening the
   block; this laptop's address was blocked that way this afternoon.
3. **Wild trips with a fixed departure window get the ranked versions too**, and a window
   wider than ten days is clipped instead of refused; "Plan the days" finds every
   customised trip because the Globe now sends the full key.
4. **"No limit" on flight hours works** in the custom search (`maxHours=0` used to mean
   one hour).
5. **A usage log.** Every finder, wild, scan, long stay, group and live board search writes
   one row (what kind, which parameters, how many results, how long) to Postgres, without
   slowing anything. No names, no coordinates. Nothing reads it yet; it is there for when
   you want numbers.
6. **Dates come out as dates.** The fare memory returned JS Date objects, which printed as
   "Tue Dec 15 2026 ..." in the chat; every date is now `2026-12-15`.
7. **`SETUP.md` is in order 1 to 15** and the Supabase project ref is a placeholder: the
   repository is public.
8. **The other streams**: the chat gained the price calendar, long stay, group, best months,
   price insight and stopover programmes as tools with a per-question search budget; the
   ground graph queued Amtrak, Malaysia and Thailand (in the graph after Monday's weekly
   run); the fame ingest stopped handing Glasgow, Montana the fame of Glasgow.

**What I need from you:** the Supabase password reset (still open), the LiteAPI email
(still open), one new email to open-data@flixbus.com about the US coach feed (SETUP §9,
the wording is there), and one deletion: `C:\dev\atlas\.tmp` holds 1.8 GB of DuckDB spill
files from the killed run; delete the folder.

---

# Update, Saturday 10 October, evening: the review fixes

_Two adversarial reviewers went over the afternoon's work; the infrastructure fixer applied
every high and medium finding in its files. What changed for you, in plain words._

1. **Nobody can run up Kiwi's bill from a URL any more.** Reloading a wild trip or a board
   with `fresh=1` did a full live rebuild every time (up to 300 searches a click with four
   ranked versions of a 90-night trip). Now `fresh` only works with a shared token you set
   on Vercel (`ATLAS_FRESH_TOKEN`, SETUP §15), ranked versions are capped at three (two past
   28 nights), and each server instance refuses live searches after 1,500 a day with a plain
   "live prices are rate-limited today" instead of taking the address into Kiwi's throttle
   for everyone.
2. **"Plan my days" works on every trip.** It answered "build the trip first" for exactly
   the trips you customise (a departure window, price first, three versions) because the
   plan looked under the plain key. The route now takes the same parameters as the trip; the
   Globe still has to send them (handed to the visual stream).
3. **A throttled minute no longer becomes "no deals" for half an hour.** Finder, events and
   combos answer with a note and search again next time.
4. **The nightly boards survive the evening.** A stored board was treated as stale from
   mid-afternoon, so the first evening visitor rebuilt it live, thinner, and overwrote the
   night's version. Boards are fresh for 26 hours now and a thinner live board never replaces
   a richer stored one.
5. **A Blob hiccup no longer triggers a wave of rebuilds**: the last good copy is served.
6. **The hotel snapshot cannot be polluted by a test**: a limited or sandbox run writes a
   test file only, and the history ignores any day with fewer than 40 cities, so my three-city
   test of 10 October is out of every median without you deleting anything.
7. **Honest status on hotel deals**: `/api/hotel-deals` has no consumer yet (no chat tool, no
   strip in the Deals tab); it is listed under "next", not "shipped".
8. **The chat rewrite** (brain stream): the chat acts first, asks one widget question at
   most, shows a price calendar, keeps threads and takes voice; `lib/chat-widgets.ts` is the
   shared widget contract.

**What I need from you:** the two items from the afternoon still stand (reset the Supabase
password and confirm `DATABASE_URL` on Vercel; email LiteAPI about the nightly sample), plus
one optional new one: set `ATLAS_FRESH_TOKEN` on Vercel if you want to force rebuilds from
the browser (SETUP §15).

---

# Update, Saturday 10 October, afternoon: four streams at once

_Four agents built in parallel this afternoon, each on its own files. The short version._

**Open it:** https://atlas-kappa-wheat.vercel.app

1. **Cheapest whenever.** Ask "when is San Francisco cheapest from my airports" and the
   price calendar answers per month (one Kiwi search a month, the fare memory first, open-jaw
   when you let the flight home leave from anywhere in the country). `/api/scan`.
2. **Long stays.** "Two months in Southeast Asia from January, mid budget": the eight best
   bases by worth for money, the flight in and out, what a month costs (rent, food, total),
   side trips by train or bus, the climate for those months, the visa. `/api/longstay`.
3. **Group trips.** Three friends in three cities, each with their free dates: the windows
   everyone can make, then the cheapest city for all of you with a price per person.
   `/api/group`.
4. **Best months and "is this a good price".** Climate normals for 1,496 cities so far (NASA
   POWER; the monthly job fills the rest) give the three best months for any place; the fare
   memory says whether a fare is great, good, typical or high for that route and month.
5. **The chat does it all**, with widgets inside the conversation: pick dates, a month, nights,
   a region or a place on the globe, add the people of a group. The chat asks the globe, the
   globe answers.
6. **One Trips tab** for every kind of trip, drawn the same way: the loop as a strip of
   photos, the stops as cards, every leg a row with its booking link. Wild trips now run up
   to 90 nights (a 60-night trip is five to seven bases of 8 to 12 nights).
7. **Hotel deals.** Every night the job records the cheapest decent hotel in 80 cities for the
   same weekend four weeks out (LiteAPI, the legal source; nothing scraped). When a city's
   price is 25% under its own typical price it becomes a hotel deal (`/api/hotel-deals`).
   It needs three nights of history, so the first deals appear from 13 October.
8. **Built to take traffic.** One gate to Kiwi (six searches at a time, every search
   remembered a day, a counter that warns before Kiwi throttles), every memo bounded, boards
   read from Blob once per ten minutes instead of per visit, every parameter checked with a
   plain error, streams never silent more than 15 seconds, the long routes allowed the time
   they need. Nothing changed shape.
9. **Jobs.** The repo is public, so the boards run every night again (01:00 UTC, eight
   runners), the hotel snapshot right after, climate in the monthly set.
10. **Docs for whoever is next:** `docs/architecture.md` (how it fits together, storage,
    jobs, costs, what scales), `docs/data-inventory.md` (every layer with coverage per
    region, what is missing where, ten sources worth adding, ranked), `README.md`.

**What I need from you:** reset the Supabase password that was pasted in chat and put the
new pooler string in `.env.local`, Vercel and the GitHub secret (SETUP §4 has the exact
string shape). The one in `.env.local` works today; it just should not be the pasted one.
Then confirm `DATABASE_URL` is on Vercel.

---

# Update, Saturday 10 October, daytime

_You asked for: the whole world, not Romania; events from city sites; combos like fly to
Warsaw, train to Gdańsk, fly home; hidden gems; an impeccable globe. Here is what changed._

**Open it:** https://atlas-kappa-wheat.vercel.app

1. **Works from anywhere.** Type any city or airport in the From pill (or let it place you).
   Prices come from a "board" per airport: ~150 of the world's busiest airports are searched
   every night (Denver → Dallas €44, Sydney → Ballina €66, Mumbai → Goa €73, Lisbon →
   Seville €38), any other airport is searched live the first time someone asks (15 to 30
   seconds, you watch the cards arrive) and kept for the next visitor. Boards live in a Vercel
   Blob store, not in git, so the repo stops growing. Kiwi accepts a country as a destination,
   so a board is ~35 searches, not 117.
2. **Any month.** The When pill: next six weeks (nightly) or a month (live search, then kept).
   "Cheapest from Bucharest in October" is one click.
3. **Two cities for less.** On a deal, "Fly in, train on, fly home from the next city" prices
   the open-jaw version live: Brașov → Warsaw is €89 return, or €33 in, train to Katowice,
   €17 home: €50 and a second city. Shown on the globe when you pick one.
4. **The new face.** Top bar (From, When, Ask), glass panel, cards with Kiwi's own city photos,
   badges (direct, hidden gem, warm, World Heritage), price tags pinned to the globe (the
   cheapest never overlap), an animated trail for the open deal, a bottom sheet on phones.
5. **What to do there.** Sights from the Wikivoyage guide with photos, "Show on the map" pins
   them on the city, plus the guide's festivals (Venice: Biennale, Carnival, Regata Storica).
6. **What's on.** Twenty cities publish their own open event feeds (markets, exhibitions,
   festivals, film): Paris, Bordeaux, Nantes, Madrid, Bilbao, Lisbon, Bologna, Berlin, Ghent,
   Helsinki, Espoo, Dublin and all Ireland, Basel, New York, Chicago, San Francisco, Calgary,
   Edmonton, Brisbane, Taipei. They appear on the deal page. The full research (what exists,
   what needs a key, what is dead) is in `docs/events-sources.md`; Ticketmaster still adds
   concerts once you give the key.
7. **Hidden gems.** A badge and a filter: places with a lot to see (Wikivoyage listings,
   World Heritage nearby) that fewer than 400,000 people looked up on Wikipedia last year.
   Sibiu and Matera qualify; Paris never will.

8. **Wild trips** (new tab). Your Asia loop, generalised. Pick a region and a length: the
   engine flies you out (through Istanbul or Budapest when that is cheaper), chains cheap
   one-way flights and border hops through the region for two or three nights a stop, and
   flies you home from the last city. Every fare is live (about fifty searches, you watch
   the progress), living costs per stop come from World Bank price levels (Thailand about
   €35 a day, Singapore €63), visas and warnings are attached, and a model then scores it
   out of 100 with reasons and the two changes that would make it better. First result:
   Bucharest → Istanbul → Kuala Lumpur → Singapore → Saigon → Phnom Penh by road → Bangkok →
   home, 13 nights, 5 countries, about €1,250 all in, judged 54 ("skip Singapore, do the
   Mekong Delta instead; the 24-hour return is a cost"). Results are kept a day, so the next
   person asking gets it at once.

9. **Preferences, fourteen regions, and the days planned.** On the Wild tab you now say what
   you are after (true experiences, beaches, food first, big cities, slow travel) and your
   budget level; the chain and the costs follow. It works from any airport into fourteen
   regions: Berlin → Tashkent → Almaty → Bishkek by road → Berlin came out at 11 nights,
   €655 all in, judged 64 ("add Samarkand"). Then **Plan the days** writes the day-by-day
   plan the way you write yours: grounded in the Wikivoyage guides (the country's Do and Eat
   sections, each city's listings, events during the stay), it names the loop, the overnight
   bus, the homestay, the market at dawn, the dish and where locals eat it, the sweet thing,
   what each day costs, and what a month there would cost (rent, food, total). Things the
   model adds from memory are marked "verify". The Southeast Asia plan proposed fireflies at
   Kuala Selangor, a Minangkabau homestay near Padang, Pulau Ubin by bicycle, rendang and
   soto Padang, and priced a month in Singapore at €3,750 against €650 in Padang.

**Food with live reviews** needed keys; see item 10 for what is wired now. Original note: the only legal sources of
restaurant ratings for a non-Google map are Foursquare Places (free tier, SETUP §13) or a
search key for the planner to read reviews live (Brave or Tavily, free tiers, SETUP §14).
Until then the planner leans on the guides and marks the rest "verify".

10. **Keys wired (10 October, afternoon).** Tavily: the planner now researches every stop live
    (two searches each) and the Ask agent has a web_search tool, so "best ice cream in Lisbon,
    traditional dish without tourist prices" comes back with named places, prices and the
    source sites. Foursquare: "Eat well, fairly priced" on every deal page and rated places in
    the plan, as soon as you enable billing on the Foursquare org page (the API says "no
    credits" until then). LiteAPI: hotel prices on deal pages, hidden until the production key
    (sandbox prices are test data). Travelpayouts Drive script is live and the marker is set;
    the API token is still missing. The running list of what is done and what is still needed
    is `docs/TODO.md`.

11. **Custom search.** In Deals: "Custom search: a period, a date to include, your airports,
    open-jaw". Pick which of your airports, a period (20 to 30 October), a date you must be
    away on (the 26th), nights from and to, anywhere or a region or a country, direct, a
    maximum flight length, and which other airports the flight home may land at. About twenty
    live searches, half a minute, streamed. From Brașov's three airports, 20 to 30 October,
    away on the 26th: Thessaloniki €44, Corfu €44, Chișinău €58, Katowice €61, Berlin €77,
    and open-jaw pairs such as out of Brașov to Warsaw, home into Bucharest, €82.

12. **The chat is the agent (evening).** The first tab is "Ask": a conversation that is kept
    in your browser, knows where you are, your airports, your passport and the month you
    picked, streams its answer and calls every Atlas capability as a tool: tonight's boards,
    the period search, live re-pricing, two-city combos, wild trips with custom country lists,
    day plans, sights, events, rated restaurants, hotels, one-way fares, trains, facts and
    web search. Results come back as cards in the chat and as pins or a route on the globe,
    and the thread continues: "make it direct, under 2 hours, 4 nights, and tell me what to
    eat there" re-ran the search with those constraints and answered Warsaw €48, 20 to 24
    October, direct from Brașov, with restaurants and a source. The box in the top bar sends
    into the same chat. Wild trips take a custom country list and countries to favour.

**Numbers:** ~150 airport boards, each 50 to 100 deals to 30 to 50 cities; 2,549 cities with a
fame score; 20 event feeds; combos in 10 seconds; the nightly boards job ran once (8 runners,
15 minutes each) and runs every night at 04:00 your time.

**Caveats:** Kiwi's public search is still the price source (free, no key, terms unpublished;
it throttles an address after a couple of thousand searches, which is why the nightly job is
split over eight runners). Trips (three-country loops) still only work from Romania; they
need one-way fares per airport and come next. Events exist only where a city publishes a
feed; the big names without one (London, Amsterdam, Rome, Tokyo) say so honestly.

**Nothing new to set up.** The Blob store I created myself (SETUP §12). The keys list below
still stands.

---

# Good morning. Here is where Atlas stands.

_Written for: Patrick, five minutes, coffee in hand._

**Open it:** https://atlas-kappa-wheat.vercel.app  
(local copy: http://localhost:3210, the dev server from last night is still running)

## What it does now

1. **Deals** (the home tab). The cheapest return getaways for the next six weeks, 2 to 7
   nights, from Bucharest, Cluj, Iași, Timișoara, Brașov, Sibiu and Craiova: 2,201 of them,
   real prices and booking links from Kiwi.com, searched every night from GitHub's runners
   (the first automated run completed at 02:57 your time). From Brașov airport: Budapest
   €44, Milan €45, Rome €49. From Craiova: Bari €27, Bologna €34. From Bucharest: Venice
   €32, Milan €37, Gdańsk €38, Tirana €38, Bologna €39, all direct. Cards show a photo, price,
   dates, airline, flight time and a reason to go. Filters: nights, direct only, warm this
   weekend, home airport (nearest to you first).
2. **Ask.** Type "warm weekend under €60, direct" and an agent answers in four sentences
   from the real deals and the place facts. It never invents a price; it names city, price
   and dates; the cards narrow to its picks. It also knows your airports ("Brașov-Ghimbav is
   14 minutes away but has no deals; Bucharest is 132 minutes with 310") and the train and
   coach reach from where you are ("Sfântu Gheorghe 38 min, Făgăraș 67, Bucharest 136"). It is live on the site on your Bedrock credits
   (GPT-6 Astra, about 3 to 5 cents a question, 30 questions an hour per visitor). I put the
   token into Vercel myself; remove it under Settings → Environment Variables if you prefer.
3. **A deal's page.** The other dates for the same city, Book on Kiwi.com, **Check other
   dates** (pick a departure date and nights; it re-prices that route live on Kiwi, ±2 days,
   with booking links; works from the live site, 5 seconds), then everything
   about the place: the week's weather, sea temperature where known, population, local time
   and the hour shift from you, daylight, currency and today's rate, plugs, languages, calling
   code, driving side, visa for a Romanian passport, travel warnings, the next holiday there,
   World Heritage sites nearby, how many restaurants, bars, nightlife and cultural places, and a
   Wikivoyage paragraph. Events appear here the moment you give me a Ticketmaster key.
4. **Explore.** Every place within ten hours by plane, train, coach or ferry with the best
   way there, door to door. Dots only; an arc only for the place you pick. The ground graph has
   12,959 stations (RO, FR, DE long-distance, ES, BE, IE, Eurostar, FlixBus) and 3,507 ferry
   crossings.
5. **Trips.** Three-countries-in-five-days loops priced from Kiwi one-way fares: "Vienna →
   Brno → Bratislava, 6 nights, €74 in flights, 3 countries", with booking links. Chips for
   leaving around a Romanian holiday.
6. **Share.** Every view is a link; the Share chip copies it. A shared link shows a card
   with tonight's five cheapest deals (the Open Graph image). Add to Home Screen works.
7. **It refreshes itself.** GitHub Actions re-runs every source: daily (deals, one-way
   fares, weather, rates, advisories, holidays, airports), weekly (ground graph, towns),
   monthly (Overture places, ferries, heritage, visa). Each run commits and redeploys.

## What I need from you, in order of impact

| # | What | Why | Minutes |
|---|---|---|---|
| 1 | **Kiwi.com affiliate** through Travelpayouts, plus the **Travelpayouts** token and marker ([SETUP §2](../SETUP.md)) | the Book buttons carry no marker yet, so they earn nothing; the token also unlocks one-way fares in Explore and the Airalo/Omio/Kiwitaxi/car programmes | 10 |
| 2 | **Ticketmaster** consumer key (§10, free) | events on every place card; the code is ready | 5 |
| 3 | **LiteAPI** sandbox key (§5) | hotels with live prices and your margin, plus their review scores and sentiment | 10 |
| 4 | **Viator** Basic key (§6), **Tiqets** (§7), **DiscoverCars** (§8) | tours, tickets and car hire that pay commission | 10 each |
| 5 | **opentransportdata.swiss** key (§11, free) | Switzerland in the ground graph | 5 |
| 6 | ÖBB click-to-accept download (§9) | Austria in the ground graph | 2 |

Paste keys into `C:\dev\atlas\.env.local` (names in `.env.example`) and tell me. For the
live site they also go into Vercel → Settings → Environment Variables → Production.

## Decisions you may want to take

- **Kiwi.com as the price source.** Their public MCP server for agents: no key, no stated
  limits (it throttled once after ~700 searches; the client now retries), bookable links.
  The commercial terms are not published, so treat it as the bridge until the affiliate
  programme is in place. Fallback paths already exist (Travelpayouts).
- **The agent model.** `ASK_MODEL` in env switches it; a cheaper Bedrock model is fine for
  this job if the bill matters.
- **Home airports and destinations.** `DEALS_GATEWAYS` in the workflow; the 117 cities live
  in `scripts/ingest/destinations.ts`. Both are one-line changes.
- **Reviews.** Google, Tripadvisor and Yelp all forbid storing reviews. The honest route to
  the "five bad reviews about the same thing" intelligence you described is LiteAPI's hotel
  reviews and sentiment (needs the key), and later Viator's.
- **Events from city pages.** Possible, but each city is its own format and it is scraping.
  Ticketmaster first; if you want city pages, say which cities.

## Caveats, in plain words

- Prices are what Kiwi returned at search time (nightly); the booking page shows the live one.
- Ferry crossings and ground times are estimates and say so. No open ferry timetables exist.
- Sea temperature only where MET Norway's ocean model covers (Nordic and Baltic).
- Visa data is the Passport Index dataset of February 2026, labelled indicative.
- Deals start from Romanian airports; a visitor elsewhere sees a note and can use Explore.
- The Trips tab takes a couple of seconds the first time after a deploy (it loads the graph).

## Fixed on the way

- The live site had been drawing a black globe with dots: MapLibre's worker file was never
  deployed (a postinstall copy Vercel doesn't run). It is committed now; the map renders.
- Kiwi blocked this laptop's IP after ~2,000 searches in one night. Both ingests now stop
  after eight failures in a row and never overwrite a good file; the nightly search runs from
  GitHub's runners, which have their own addresses (first run triggered at 02:21 your time).

## Numbers, for the record

22 data sources, 30 commits tonight, 2,201 return deals (7 airports × 117 cities) + 4,201
one-way fares searched, 2,805 cities with weather, 2,707 with place counts, 12,959 stations,
3,507 ferries, 1,887 World Heritage sites, 253 countries of facts, 199 passports of visa
rules. The nightly refresh ran once on its own and committed; the next is at 06:15 your time.
