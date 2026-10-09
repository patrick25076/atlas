# Good morning. Here is where Atlas stands.

_Written for: Patrick, five minutes, coffee in hand._

**Open it:** https://atlas-kappa-wheat.vercel.app  
(local copy: http://localhost:3210, the dev server from last night is still running)

## What it does now

1. **Deals** (the home tab). The cheapest return getaways for the next six weeks, 2 to 7
   nights, from Bucharest, Cluj, Iași and Timișoara (Brașov, Sibiu and Craiova are in the
   nightly search too; Kiwi blocked my IP for a while last night before they finished, so
   they appear with the first scheduled run). Real prices and booking links from Kiwi.com,
   searched every night. Tonight's board: Venice
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

22 data sources, 13 commits tonight, 1,287 return deals + 4,201 one-way fares searched,
2,805 cities with weather, 2,707 with place counts, 12,959 stations, 3,507 ferries, 1,887
World Heritage sites, 253 countries of facts, 199 passports of visa rules.
