# Good morning. Here is where Atlas stands.

_Written for: Patrick, five minutes, coffee in hand._

**Open it:** https://atlas-kappa-wheat.vercel.app (local: http://localhost:3210, the dev
server from last night is still running)

## What it does now

1. **Deals** (the home tab): the cheapest return getaways from Bucharest, Cluj, Iași and
   Timișoara for the next six weeks, 2 to 7 nights. Real prices and booking links from
   Kiwi.com, searched every night (1,287 itineraries over 117 cities; Venice €32, Milan €37,
   Gdańsk €38, Tirana €38, Bologna €39, all direct). Cards with a photo, price, dates, airline,
   and a reason to go. Filters: nights, direct only, warm this weekend, airport.
2. **Ask**: type "warm weekend under €60, direct" and an agent answers in four sentences from
   the real deals and place facts, never inventing a price, and the cards narrow to its picks.
   Runs on your Bedrock credits (GPT-6 Astra). It is live on the site: I put your Bedrock
   token into Vercel's production env, capped at 30 questions an hour per visitor. Each
   question costs about 3 to 5 cents. Remove it in Vercel → Settings → Environment Variables
   if you'd rather not.
3. **A deal's page**: dates and the other dates for the same city, Book on Kiwi.com, then
   the place card: weather for the week, sea temperature where known, population, local time,
   daylight, currency and today's rate, plugs, languages, calling code, driving side, visa
   for a Romanian passport, travel warnings, next holiday there, World Heritage sites nearby,
   how many restaurants/bars/nightlife/culture/nature, and a Wikivoyage paragraph.
4. **Explore**: every place within 10 hours by plane, train, coach or ferry with the best
   way there. Dots only; an arc only for the place you pick. 12,959 stations across RO, FR,
   DE (long distance), ES, BE, IE, Eurostar, FlixBus, plus 3,507 ferry crossings.
5. **Trips**: 3-countries-in-5-days loops, priced from Kiwi one-way fares (searched nightly).
6. **Share**: every view is a link.
7. **It refreshes itself**: GitHub Actions re-runs every ingest (daily: deals, one-way,
   weather, rates, holidays; weekly: ground graph, towns; monthly: Overture, ferries,
   heritage, visa) and commits, which redeploys.

## What I need from you, in order of impact

| # | What | Why | Minutes |
|---|---|---|---|
| 1 | **Travelpayouts** token + marker ([SETUP §2](../SETUP.md)) | affiliate links that pay, one-way fares for Explore; also the hub for Airalo, Omio, Kiwitaxi, cars | 5 |
| 2 | **Ticketmaster** consumer key (§10) | events on every place card (code is ready) | 5 |
| 3 | **LiteAPI** sandbox key (§5) | hotels with live prices and your margin | 10 |
| 4 | **Viator** Basic key (§6), **Tiqets** (§7), **DiscoverCars** (§8) | tours, tickets, car hire that pay commission | 10 each |
| 5 | **opentransportdata.swiss** key (§11) | Switzerland in the ground graph | 5 |
| 6 | ÖBB download (§9) | Austria in the ground graph | 2 |
| 7 | **Kiwi.com affiliate** (Travelpayouts has a Kiwi programme) | the booking links from Deals currently carry no marker, so they earn nothing yet | 5 |

Paste keys into `C:\dev\atlas\.env.local` (names in `.env.example`) and tell me. For the
live site they also go into Vercel → Settings → Environment Variables → Production.

## Decisions you may want to take

- **Kiwi.com as the price source.** It's their public MCP server, no key, no stated limits,
  and the links are bookable. The commercial terms are not published, so treat it as the
  bridge until Travelpayouts/Kiwi affiliate links are in place.
- **The agent model.** GPT-6 Astra on Bedrock is good but pricey (~$11/$55 per million
  tokens). `ASK_MODEL` in env switches it; a cheaper Bedrock model would do for this job.
- **Your home airports.** The deals search covers OTP, CLJ, IAS, TSR. `DEALS_GATEWAYS` in
  the workflow changes that (SBZ, CRA, SUJ are easy additions).
- **Destinations list.** 117 cities in `scripts/ingest/destinations.ts`; add codes to widen.

## Caveats, in plain words

- Prices are what Kiwi returned at search time; the booking page shows the live one.
  Nightly refresh keeps them within a day.
- Ferry crossings and ground times are estimates, labelled as such. No timetable source for
  ferries exists without accounts.
- Sea temperature exists only where MET Norway's ocean model covers (Nordic/Baltic).
- Reviews: no legitimate review source works without accounts (Google, Tripadvisor, Yelp
  all forbid storing them). LiteAPI's hotel reviews and sentiment come with the LiteAPI key.
- Events: Ticketmaster only, once you give the key. City-page scraping is possible but each
  city is its own format; say the word and I'll start with Bucharest.
- Visa data is the Passport Index dataset of February 2026, indicative.
