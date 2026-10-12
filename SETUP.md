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

- Repo: https://github.com/patrick25076/atlas (**public** since 2026-10-10, so GitHub
  Actions minutes are unlimited and the boards job runs every night again). Secrets held
  by the repo: `BLOB_READ_WRITE_TOKEN`, `LITEAPI_KEY`, `DATABASE_URL`.
- Vercel project `atlas` in scope `patrick25076s-projects`, connected to the repo: every
  push to `main` deploys production, branches get previews.
- Production: https://atlas-kappa-wheat.vercel.app
- `vercel link` wrote a `VERCEL_OIDC_TOKEN` into `.env.local`; leave it, add your own keys
  below it.

## 4. Postgres (Supabase, free tier): the shared fare memory, hotel price history, saved trips

Atlas remembers every fare any search ever saw (with its timestamp) so the next person gets
history for free, keeps the nightly hotel price snapshots (the hotel deals compare against
them), keeps saved trips, and logs searches. It needs one connection string, `DATABASE_URL`.
Without it every database function is a quiet no-op; the moment the variable appears, the
tables (`fares`, `trips`, `searches`, `hotel_prices`) are created on first use.

**The project exists** (2026-10-10): Supabase project ref `<project-ref>`, region
`eu-west-1` (Ireland). Three things to know about connecting to it:

1. **Use the pooler, not the direct host.** `db.<project-ref>.supabase.co` is IPv6
   only and cannot be reached from Vercel, GitHub Actions or this laptop. The pooler host is
   `aws-1-eu-west-1.pooler.supabase.com` and the user is `postgres.<project-ref>`
   (the project ref after a dot; a plain `postgres` user is rejected by the pooler).
2. **Transaction mode, port 6543**, is the right one for Vercel functions and the nightly
   jobs (short-lived connections, many instances). The exact string:
   ```
   postgresql://postgres.<project-ref>:<PASSWORD>@aws-1-eu-west-1.pooler.supabase.com:6543/postgres
   ```
   Transaction mode forbids prepared statements; `lib/db.ts` sets `prepare: false` and
   `ssl: require` itself. Session mode (port 5432, same host and user) is only for a long
   interactive session such as psql.
3. **The password that was pasted in chat must be reset** before this is considered live:
   Supabase → Project Settings → Database → Reset database password. Then put the new
   string in three places: `.env.local`, Vercel → Settings → Environment Variables →
   Production (`DATABASE_URL`), and the GitHub secret
   (`gh secret set DATABASE_URL -R patrick25076/atlas`, paste the value at the prompt).

Status on 2026-10-10 afternoon: `.env.local` carries a pooler string on port 6543 that
works (the hotel snapshot test wrote three rows into `hotel_prices`), the GitHub secret
`DATABASE_URL` was set at 11:54 UTC, Vercel is **not verified** from here: check it in the
dashboard, then open `/api/hotel-deals` on the live site after the next nightly run.

Neon works the same way if you ever move: https://neon.tech → New project, region
Frankfurt → the pooled connection string as `DATABASE_URL`.

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
4. **Done 2026-10-10:** production key in `.env.local`, on Vercel and as the GitHub secret
   `LITEAPI_KEY`; `LITEAPI_ENV=production`. The nightly `hotels` job
   (`scripts/ingest/hotels.ts`) keeps one price per city per night, the cheapest decent
   hotel for a standard weekend, 80 cities, 160 calls a night: a price sample, not a hotel
   database. LiteAPI is the only source of hotel prices here; nothing is scraped from
   Booking, Google, Yelp or Tripadvisor. Point 3 still applies: ask them in writing.
5. **Test runs never touch the real snapshot.** `HOTELS_LIMIT=3` or `HOTELS_CITIES=BKK,LIS`
   or a sandbox key writes `hotels/test-<date>.json` only, no `latest.json`, no Postgres;
   `HOTELS_WRITE=1` overrides that when a short run is meant for real. The deals ignore any
   day with fewer than 40 cities and any snapshot marked sandbox, so the three-city test of
   2026-10-10 is out of every median; delete its rows (`delete from hotel_prices where
   seen_at::date = '2026-10-10'`) and `hotels/snapshot-2026-10-10.json` when convenient.

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

**Also under this heading, the Flix US feed.** The ground graph includes FlixBus and
Greyhound's United States network from Flix's own developer feed
(`https://gtfs.gis.flix.tech/gtfs_generic_us.zip`, entry `flix-us` in
`scripts/ingest/feeds.ts`). The file is published for developers with no licence text next
to it (the European twin is ODbL on transport.data.gouv.fr). Email open-data@flixbus.com and
ask whether using the US feed for estimated coach connections on a travel map, with
attribution, is fine; paste the answer into `docs/data-inventory.md`, where the feed is
marked "permission pending" until then.

## 10. Ticketmaster Discovery API (events, free key)

Concerts, sport and theatre in about 30 countries, 5,000 calls a day for free.

1. https://developer.ticketmaster.com → Create account → My Apps → New App. Copy the
   Consumer Key into `.env.local` as `TICKETMASTER_KEY`.
2. Tell me; events for the selected place (next 30 days) go on the card, with the
   affiliate link once you join their programme on Impact.

## 11. Swiss timetables (opentransportdata.swiss, free key)

Switzerland's full GTFS (trains, buses, boats) is open but needs a key.

1. https://opentransportdata.swiss → register → API keys → "GTFS static" (or the open
   data download page). Copy the key into `.env.local` as `OTD_SWISS_KEY`.
2. Tell me; I add the feed to `scripts/ingest/feeds.ts` with the key and rebuild the graph.

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

## 15. A shared token for forced rebuilds (`ATLAS_FRESH_TOKEN`), optional

`/api/board`, `/api/wild` and `/api/plan` used to rebuild on `fresh=1`, which let anyone
reload a public URL into 35 to 300 Kiwi searches a time. Now `fresh=<token>` only works
when it matches `ATLAS_FRESH_TOKEN`; without the variable the parameter is ignored and the
stored answer is served. Only needed if you want to force a rebuild from the browser.

1. Make a long random string (for example `openssl rand -hex 24`).
2. Vercel → Settings → Environment Variables → Production: `ATLAS_FRESH_TOKEN` = that string.
   Put the same line in `.env.local` for local use. Never paste it in chat.
3. Force a rebuild with `.../api/board?from=OTP&fresh=<the string>`.

## 16. The access code: Atlas is private (do this on Vercel now)

Since 2026-10-12 every page and API route asks for an access code first (`proxy.ts`), so
strangers cannot run up the model, Kiwi, Tavily, Foursquare or LiteAPI bills. Open without
the code: the `/access` page, shared itinerary links (`/i/<id>`, their preview image and
calendar file), static files. Search engines are told to stay out (`robots.txt` disallows
everything, every response carries `X-Robots-Tag: noindex`).

The code and the cookie secret were generated on the laptop and are already in
`.env.local` (never paste them in chat). **Do steps 1 to 3 before this change reaches
production.** Until it does, the live site is still the old, public one. Once it is deployed
without the code, the production site fails closed: every page and API answers 503 "Atlas is
not configured yet" (shared itinerary links still open) and its logs say
`ACCESS GATE NOT CONFIGURED IN PRODUCTION`. That is on purpose: a dropped env var must never
make the site public again. (`ATLAS_GATE_OFF=1` on Vercel is the deliberate way to run it
public; do not set it unless you mean that.)

1. Open `.env.local` in an editor and copy the two lines `ATLAS_ACCESS_CODE=...` and
   `ATLAS_COOKIE_SECRET=...`.
2. Vercel → the `atlas` project → Settings → Environment Variables → Add: name
   `ATLAS_ACCESS_CODE`, value the code, environments **Production and Preview**. Then the
   same for `ATLAS_COOKIE_SECRET`. Mark both Sensitive.
   (CLI alternative: `vercel env add ATLAS_ACCESS_CODE production` and paste when asked;
   repeat for `preview` and for the secret.)
3. Redeploy: Deployments → the latest production deployment → ⋯ → Redeploy (environment
   variables only apply to new deployments).
4. Check: open https://atlas-kappa-wheat.vercel.app in a private window. It should show
   "Atlas is private for now. Enter the access code." Type the code; you land on the page
   you asked for and stay signed in for 90 days on that browser.
5. Give the code to whoever should see Atlas. To lock everyone out again, change
   `ATLAS_ACCESS_CODE` on Vercel and redeploy: every old cookie stops working.

Scripts and other machines can skip the cookie with the header `x-atlas-access: <code>`.
A wrong code in that header waits 600 ms and an address gets ten wrong ones a minute, then
429, the same as the form, so a short code you pick yourself in step 5 cannot be guessed
fast. Still prefer a long one (12 characters or more).
On the laptop's dev server the gate is off (localhost is not public) unless `.env.local`
has `ATLAS_GATE_DEV=1`.

The daily caps (`lib/usage-caps.ts`) need nothing from you: with `DATABASE_URL` they are
counted in the `usage_daily` table. Raise one with `ATLAS_CAP_<KIND>` on Vercel if the real
traffic outgrows it (defaults: chat turns 400, model calls 250, Tavily 250, Foursquare 250,
LiteAPI 400 a day).

## 17. Reconnect Vercel to GitHub (pushes stopped deploying on 12 October)

Since commit 2eaec90 a push to `main` no longer starts a Vercel build (GitHub shows no deployment for the
commits after it; one attempt failed with `git_info_fail`). Until this is fixed, each deploy is started by hand
from the exact commit on GitHub (Claude does it with `vercel api /v13/deployments` and a `gitSource`).

1. Vercel → project **atlas** → Settings → Git. If the repository shows as disconnected, connect
   `patrick25076/atlas` again, production branch `main`.
2. GitHub → Settings → Applications → Vercel → Configure: make sure the app still has access to the `atlas`
   repository (it became public on 10 October; access set to "selected repositories" can drop it).
3. Push any small commit and check that a deployment appears under the commit on GitHub within a minute.

## 18. The engine room on the live site (done 12 October)

`/admin` on the live site asks for the owner's key once per browser (90 days). The key is `ATLAS_ADMIN_KEY`:
in `.env.local` (copy it from there) and in Vercel's production env. To change it, set a new value in both
places and redeploy; every browser is then signed out of the engine room. To turn the run log off without
touching the code, set `ATLAS_RUN_LOG=0` on Vercel.
