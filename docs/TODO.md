# Atlas: what is done, what is wired, what is still needed

_Kept by the agent; updated every session. Plain language._

## Keys and accounts

| Service | Status | What it gives | Still needed |
|---|---|---|---|
| Kiwi.com public search | working, no key | all flight prices and booking links | nothing (terms unpublished; watch) |
| Vercel + Blob store | done | hosting, stored boards, trips, plans | nothing |
| Bedrock (GPT-6 Astra) | done | Ask agent, trip judge, day planner | nothing; `ASK_MODEL` switches models |
| Travelpayouts | done: Drive script, marker 583720, API token (2026-10-10) | Kiwi clicks earn commission; cached one-way fares (Explore, Trips) with marker links | join more programs inside Travelpayouts (Airalo, Omio, Hostelworld, Klook) for more earning links |
| Tavily search | key saved 2026-10-10, wired in | live review research for the planner and Ask | nothing (free tier ~1,000 searches a month; a plan uses about 10) |
| Foursquare Places | done 2026-10-10: card on file, auto-recharge $20, 500 free Pro calls | restaurant ratings, price tiers, tips on deal pages, in plans and in Ask | watch the Transactions table after a few days to see credits per call; we cache every city a day (two calls per city per day at most). Reset the OAuth client secret you pasted (not used) |
| LiteAPI | sandbox key saved 2026-10-10, wired in | hotel prices on deal pages | **production key** (sandbox prices are test data, so the site hides them until `LITEAPI_ENV=production`) |
| Ticketmaster | skipped for now | concerts and shows outside the 20 city feeds | a free key, when you want it |
| DiscoverCars | skipped for now | car hire commission | an affiliate id, when you want it |
| Viator Basic | applied, takes time | bookable experiences with commission | the key when it arrives |
| Tiqets | applied, takes time | attraction tickets | the key when it arrives |
| opentransportdata.swiss | not yet | Switzerland on the ground map | a free key |
| ÖBB GTFS | not yet | Austria on the ground map | the zip in `data/raw/` |
| Neon Postgres | not needed yet | accounts, fare watches | later |

## Decisions waiting on you

- **GitHub Actions minutes**: the boards job now runs every other night (about 2,000 minutes a
  month, the private-repo allowance). Say "make it public" and it goes back to nightly for free.

## Built and live

Worldwide price boards (nightly for ~150 airports, live for the rest), month search, deals
with photos and badges, price tags on the globe, two-city combos, sights from Wikivoyage with
pins, festivals, what's on from 20 city feeds, hidden gems, Ask agent, wild trips with
preferences into 14 regions, the judge, the day-by-day planner with food and monthly costs.

## Built today, evening

- **The chat is now the agent.** "Ask" tab: a persistent conversation (kept in your browser)
  that knows where you are, your airports, your passport and the selected month, streams its
  answer, and calls every Atlas capability as a tool: tonight's boards, the period search,
  live re-pricing, two-city combos, wild trips (with custom country lists), day plans, sights,
  events, rated restaurants, hotels, one-way fares, trains, facts, web search. Results appear
  as cards in the chat and as pins or a route on the globe; "make it direct", "from Cluj too",
  "what do I eat there" continue the thread. The top-bar box sends into the same chat.

## Built today, afternoon

- Bigger type and lists everywhere (panel 468px, 14 to 17px text, visible scrollbar).
- Wild trips fly home into any of your airports and add the last leg to your door (Bucharest →
  Brașov by train or car), try a stopover night in a hub on the way back when it costs about
  the same, and Trips work from any airport (Travelpayouts cached fares).
- Hidden-city ("skiplag") scan as an opt-in in the custom search, shown with the warning.
  flightlist.io is a front end on the same Kiwi engine; nothing to integrate.
- Custom search ("Finder") in the Deals tab: a period, a date you must be away on, nights from
  and to, which of your airports, anywhere or a region or a country, direct, max hours, and
  "flying home may land at" another of your airports (open-jaw, two tickets).
- Travelpayouts token: cached one-way fares with marker links in Explore and Trips.

## Next on the list

- Hotel booking through LiteAPI once the production key exists (prices already wired).
- Viator experiences in the plan once the key arrives.
- Alternatives for a wild trip (two or three variants, not one).
