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

## 4. Neon Postgres (free tier): trips, users, fare watches

Needed only once the agent, accounts or watches land. Not yet.

1. https://neon.tech → New project, region **Frankfurt (eu-central-1)**.
2. Copy the pooled connection string into `.env.local` as `DATABASE_URL`, and into Vercel.
