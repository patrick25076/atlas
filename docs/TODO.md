# Atlas: what is done, what is wired, what is still needed

_Kept by the agent; updated every session. Plain language._

## Keys and accounts

| Service | Status | What it gives | Still needed |
|---|---|---|---|
| Kiwi.com public search | working, no key | all flight prices and booking links | nothing (terms unpublished; watch) |
| Vercel + Blob store | done | hosting, stored boards, trips, plans | nothing |
| Bedrock (GPT-6 Astra) | done | Ask agent, trip judge, day planner | nothing; `ASK_MODEL` switches models |
| Travelpayouts Drive script | done, marker 583720 | Kiwi clicks earn commission | **the API token** (Profile → API token): one-way fares in Explore, trips from any airport |
| Tavily search | key saved 2026-10-10, wired in | live review research for the planner and Ask | nothing (free tier ~1,000 searches a month; a plan uses about 10) |
| Foursquare Places | key saved 2026-10-10, wired in | restaurant ratings, price tiers, tips | **enable billing on https://foursquare.com/developers/orgs** (the API answers "no credits" until the org has a payment method; the free allowance then applies); reset the OAuth client secret you pasted (not used) |
| LiteAPI | sandbox key saved 2026-10-10, wired in | hotel prices on deal pages | **production key** (sandbox prices are test data, so the site hides them until `LITEAPI_ENV=production`) |
| Ticketmaster | skipped for now | concerts and shows outside the 20 city feeds | a free key, when you want it |
| DiscoverCars | skipped for now | car hire commission | an affiliate id, when you want it |
| Viator Basic | applied, takes time | bookable experiences with commission | the key when it arrives |
| Tiqets | applied, takes time | attraction tickets | the key when it arrives |
| opentransportdata.swiss | not yet | Switzerland on the ground map | a free key |
| ÖBB GTFS | not yet | Austria on the ground map | the zip in `data/raw/` |
| Neon Postgres | not needed yet | accounts, fare watches | later |

## Decisions waiting on you

- **GitHub Actions minutes**: private repo = 2,000 free minutes a month; the nightly boards job
  uses about 4,000. Make the repo public (free, unlimited) or I cut the job to 4 runners every
  other night.

## Built and live

Worldwide price boards (nightly for ~150 airports, live for the rest), month search, deals
with photos and badges, price tags on the globe, two-city combos, sights from Wikivoyage with
pins, festivals, what's on from 20 city feeds, hidden gems, Ask agent, wild trips with
preferences into 14 regions, the judge, the day-by-day planner with food and monthly costs.

## Next on the list

- Hotel booking through LiteAPI once the production key exists (prices already wired).
- Viator experiences in the plan once the key arrives.
- Trips tab from any airport (one-way fares per airport).
- Alternatives for a wild trip (two or three variants, not one).
