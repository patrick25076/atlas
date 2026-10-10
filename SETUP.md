# Atlas: manual setup steps

Everything outside the codebase lives here, numbered, in the order it is needed. A step is
listed when the code needs it; nothing here is assumed done.

## 1. Run it locally (no accounts needed)

```
pnpm install      # also copies MapLibre's worker into public/
pnpm ingest       # downloads OurAirports + OpenFlights into public/data (about 10 s)
pnpm dev -p 3210  # http://localhost:3210
```

The globe asks for your location. Say no and it shows Brașov.

## 2. Travelpayouts (free): current flight routes and cached fares

Replaces the 2014 OpenFlights network with routes people actually fly today, and adds
"from €X" prices to every arc. Also the affiliate hub for Airalo, Saily, Omio, Kiwitaxi,
Welcome Pickups and Compensair later.

1. Create an account at https://www.travelpayouts.com (choose "Travel blogger / website").
2. Join the **Aviasales** programme (Programs → Aviasales → Join).
3. Tools → **API** → copy the API token.
4. Your **marker** (partner id) is at the top of the dashboard.
5. Put both in `.env.local`:
   ```
   TRAVELPAYOUTS_TOKEN=...
   TRAVELPAYOUTS_MARKER=...
   ```
6. Restart `pnpm dev`. The destinations panel switches from "No fares yet" to priced rows.
   (`pnpm check:tp OTP` prints what the API returns, if you want to see it raw.)
7. For the deployed site, add the same two variables in Vercel: Project → Settings →
   Environment Variables (Production), then redeploy.

Note: affiliate programmes beyond Aviasales usually ask for a live website URL. Use
https://atlas-kappa-wheat.vercel.app.

## 3. GitHub repository and Vercel project (done 2026-10-09)

- Repo: https://github.com/patrick25076/atlas (private).
- Vercel project `atlas` in scope `patrick25076s-projects`, connected to the repo: every
  push to `main` deploys production, branches get previews.
- Production: https://atlas-kappa-wheat.vercel.app
- `vercel link` wrote a `VERCEL_OIDC_TOKEN` into `.env.local`; leave it, add your own keys
  below it.

## 5. LiteAPI (hotels: live prices, booking, you set the margin)

1. https://www.liteapi.travel → Sign up. A **sandbox** key is issued at once; production
   keys after their KYC.
2. Dashboard → API keys → copy the sandbox key into `.env.local` as `LITEAPI_KEY` (and
   `LITEAPI_ENV=sandbox`). Switch to the production key later.
3. Before we store anything beyond live lookups, email support@liteapi.travel asking in
   writing whether (a) keeping a nightly price sample of a watchlist of hotels and
   (b) matching their hotel ids to Overture place ids are allowed under their ToS. Their
   terms forbid "creating databases" and "mapping data to third-party sources"; a yes in
   writing is the only safe basis. Paste the answer into `docs/liteapi-permission.md`.

## 6. Viator Partner API, Basic access (tours and activities, 8%)

1. https://partnerresources.viator.com → Join the affiliate programme (direct, not via
   Awin: Awin pays 4%, direct pays 8%).
2. Once approved, Partner Portal → API → request **Basic** access (instant, no traffic
   minimum). Copy the API key into `.env.local` as `VIATOR_API_KEY`.
3. Basic access allows search and single-product reads only. Full access (needed to cache
   the catalogue for the globe) requires certification; ask for it once we have traffic.

## 7. Tiqets (attraction tickets)

1. https://www.tiqets.com/en/partner-program/api-program/ → apply. Content and
   Availability API keys come with the sign-up.
2. Copy the key into `.env.local` as `TIQETS_API_KEY`.
3. The Booking API opens at about 200 orders a month; until then, bookings link out with
   your partner id (`TIQETS_PARTNER_ID`).

## 8. DiscoverCars (car rental, about $20 per booking, 365-day cookie)

1. https://www.discovercars.com/affiliate → sign up with the site URL
   https://atlas-kappa-wheat.vercel.app.
2. Copy your affiliate id into `.env.local` as `DISCOVERCARS_AFFILIATE_ID`. Ask them for
   XML API access in the same dashboard; put the key in `DISCOVERCARS_API_KEY` when it
   arrives.

## 9. ÖBB timetable (Austria), manual download

ÖBB publishes its GTFS under CC BY 4.0 but behind a click-to-accept page, updated yearly.

1. https://data.oebb.at/de/datensaetze~soll-fahrplan-gtfs~ → accept the terms → Download.
2. Save the zip as `data/raw/gtfs/at-oebb.zip` (the folder is gitignored).
3. Tell me; I'll add a local-file entry to `scripts/ingest/feeds.ts` and rerun `pnpm ingest:gtfs`.

## 11. Swiss timetables (opentransportdata.swiss, free key)

Switzerland's full GTFS (trains, buses, boats) is open but needs a key.

1. https://opentransportdata.swiss → register → API keys → "GTFS static" (or the open
   data download page). Copy the key into `.env.local` as `OTD_SWISS_KEY`.
2. Tell me; I add the feed to `scripts/ingest/feeds.ts` with the key and rebuild the graph.

## 10. Ticketmaster Discovery API (events, free key)

Concerts, sport and theatre in about 30 countries, 5,000 calls a day for free.

1. https://developer.ticketmaster.com → Create account → My Apps → New App. Copy the
   Consumer Key into `.env.local` as `TICKETMASTER_KEY`.
2. Tell me; events for the selected place (next 30 days) go on the card, with the
   affiliate link once you join their programme on Impact.

## 4. A Postgres database (Supabase or Neon, free tier): the shared fare memory, saved trips, fare watches

Atlas remembers every fare any search ever saw (with its timestamp) so the next person gets
history for free, keeps saved trips, and logs searches. It needs one connection string.
Either works:
- **Supabase**: https://supabase.com → New project, region **Frankfurt** → Project Settings → Database →
  Connection string (URI, "Transaction" pooler on port 6543). Paste it as `DATABASE_URL`.
- **Neon**: as below.
Tables are created automatically on first use.


Needed only once the agent, accounts or watches land. Not yet.

1. https://neon.tech → New project, region **Frankfurt (eu-central-1)**.
2. Copy the pooled connection string into `.env.local` as `DATABASE_URL`, and into Vercel.

## 12. Vercel Blob store for the price boards (done, nothing to do)

The cheapest-getaway boards for ~150 airports worldwide are rebuilt every night and stored
in a Vercel Blob store called `atlas-boards` (public read, linked to the `atlas` project),
not in git, so the repository does not grow by megabytes a day. I created the store with
the CLI on 2026-10-10 and put its token in two places: the project's environment variables
on Vercel (`BLOB_READ_WRITE_TOKEN`, pulled into `.env.local` locally) and a GitHub Actions
secret of the same name, which the nightly job uses. If you ever rotate it: Vercel → Storage
→ atlas-boards → tokens, then update the GitHub secret (`gh secret set BLOB_READ_WRITE_TOKEN`).
Free tier is plenty: a board is 50 to 200 KB and the site reads it through its own cache.

## 13. Foursquare Places API (live restaurant ratings, price tier, tips), free tier

The one legal, keyed source of restaurant ratings and short reviews that may be shown on a
non-Google map. Google Places forbids its content on other maps in the EEA, Yelp forbids
AI use, Tripadvisor's content API is partner-only. Foursquare's Places API has a free
monthly allowance (sign up at https://foursquare.com/developers/, create a project, copy the
API key). Put it in `.env.local` and Vercel as `FOURSQUARE_API_KEY`. **Then open
https://foursquare.com/developers/orgs → your organisation → billing and enable automatic
payments (or add credits): a new organisation answers every call with "no API credits" until
then, even inside the free allowance.** The planner then
checks every "where to eat" it names (rating, price tier, the top tips) instead of relying on
memory.

## 14. A web search key for live review research (Brave Search or Tavily), free tier

"What is the best traditional food here and where, without paying tourist prices" needs a
live search over many reviews, not a fixed database. Brave Search API
(https://brave.com/search/api/, free plan with a monthly quota) or Tavily
(https://tavily.com/, free developer tier) give the planner a search tool. Name:
`BRAVE_SEARCH_KEY` or `TAVILY_API_KEY`. Until one exists, the planner labels its restaurant
picks "verify" and leans on the Wikivoyage Eat listings.
