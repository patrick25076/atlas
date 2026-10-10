# Update, Friday 10 October, daytime

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
