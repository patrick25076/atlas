# Good morning. Here is where Atlas stands.

_Written for: Patrick, five minutes, coffee in hand._

**Open it:** https://atlas-kappa-wheat.vercel.app (local: http://localhost:3210)

## What you can do on it right now

1. **Deals**: the cheapest return getaways from Bucharest, Cluj, Iași and Timișoara for the
   next six weeks, 2 to 7 nights, real prices from Kiwi.com with a booking button. Filter by
   nights, direct only, warm this weekend, airport. Click a card: dates, airline, weather,
   visa, money, plugs, what's there, World Heritage nearby, a paragraph about the place.
2. **Explore**: every place within 10 hours by plane, train, coach or ferry, door to door,
   with the best way to get there. Dots only; arcs only for the place you pick.
3. **Trips**: 3-countries-in-5-days loops. Built, waiting on fares (see keys below).
4. **Share**: every view is a link. The Share button copies it.

## What I need from you (in order of impact)

| # | Account / key | Why | Where it goes |
|---|---|---|---|
| 1 | **Travelpayouts** token + marker (SETUP §2, 5 min) | one-way fares for Explore and the Trips tab; affiliate hub (Airalo, Omio, Kiwitaxi, cars) | `.env.local` + Vercel env |
| 2 | **LiteAPI** sandbox key (§5) | hotels with live prices, your margin | `.env.local` |
| 3 | **Viator** Basic key (§6) | tours and activities, 8% | `.env.local` |
| 4 | **Tiqets** key (§7) | attraction tickets | `.env.local` |
| 5 | **DiscoverCars** affiliate id (§8) | car hire, ~$20 a booking | `.env.local` |
| 6 | **Ticketmaster** consumer key (§10, free) | events on the place card | `.env.local` |
| 7 | **opentransportdata.swiss** key (§11, free) | Switzerland in the ground graph | `.env.local` |
| 8 | ÖBB click-to-accept download (§9) | Austria in the ground graph | `data/raw/gtfs/` |

Everything else runs with no account at all and refreshes itself (GitHub Actions, nightly).

## Decisions you may want to take

- (filled in below as the night goes on)

## Caveats, in plain words

- (filled in below)
