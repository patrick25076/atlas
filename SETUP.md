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
6. Run `pnpm ingest:fares` once it exists (next slice) and restart `pnpm dev`.

Note: affiliate programmes beyond Aviasales usually ask for a live website URL. Do step 3
first if they refuse the application.

## 3. GitHub repository and Vercel project

1. `gh repo create atlas --private --source . --push` from `C:\dev\atlas` (or create it in
   the GitHub UI and `git remote add origin ...`).
2. https://vercel.com/new → import the repo. Framework: Next.js, root `.`, build command
   default. Add the env vars from `.env.example` under Settings → Environment Variables.
3. Every push to `main` deploys. Preview deployments come from branches.

## 4. Neon Postgres (free tier): trips, users, fare watches

Needed only once the agent, accounts or watches land. Not yet.

1. https://neon.tech → New project, region **Frankfurt (eu-central-1)**.
2. Copy the pooled connection string into `.env.local` as `DATABASE_URL`, and into Vercel.
