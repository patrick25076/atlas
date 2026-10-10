import { parseExclude } from "@/lib/been";
import { buildWild, customKey, parseCities, parseCountries, parseNightsRange, REGIONS, wildPath, type Budget, type Region, type Style, type Tradeoff, type WildTrip } from "@/lib/wild";
import { buildWildVariants } from "@/lib/wild-variants";
import { judgeTrip } from "@/lib/judge";
import { readJson, writeJson } from "@/lib/boards-store";
import { mainGateway } from "@/lib/board";
import { logSearch } from "@/lib/db";
import { InFlight, keepAlive } from "@/lib/memo";
import { bad, iataList, intIn, iso2, isoDay, isoMonth, latLon, oneOf } from "@/lib/params";

// GET /api/wild?g=OTP,SBZ&home=RO&region=sea&nights=14[&month=2026-11][&from=2026-11-03&to=2026-11-10][&fresh=<token>]
//     [&exclude=TH,VN][&countries=Vietnam,Thailand][&prefer=VN][&maxStops=4][&nightsPerStop=3-5]
//     [&mustInclude=Hanoi,BKK][&maxFlightHours=12][&startFrom=LON,PAR][&wishes=temples+and+street+food,+no+beaches]
// A wild trip: the way in, a chain of cheap hops through the region, the way home, costs and
// a verdict. 5 to 90 nights; a month, or an explicit departure window, clipped to ten days
// (to becomes from + 10 days when it is further; only to < from or a date that is not real
// is a 400). exclude is the "Been" list (ISO2): those countries are never a stop and never
// a stopover night; a hub there is still fine as positioning, a layover is always fine.
//
// The traveller is not held to the region's list: countries (names or codes, any mix) keeps
// the chain to those, and region=custom with a countries list goes anywhere in the world;
// mustInclude (city names or codes) are stops the chain passes through, nearest first;
// maxFlightHours skips every itinerary longer than that door to door; startFrom flies the way
// in from those airports instead of the home ones; wishes is free text the chain leans on and
// the judge and the planner read; nightsPerStop takes a range ("3-5"). An unknown country or
// city is a 400 naming it. Every one of these shapes the stored trip's key (lib/wild.ts
// customKey), so a constrained build never answers a plain request; /api/plan mirrors it.
//
// Kiwi searches per version, worst case: up to 3 origins × 8 region countries for the way in
// (24, plus 3 for a must city), up to 4 for the positioning hub, one per stop and candidate
// country for the chain (7 stops × 4 countries, 28), 2 for the way home, up to 8 for the
// stopover: about 65. A 14-night single trip is typically 40 to 60. Variants multiply that, so
// they are capped at 3 (2 past 28 nights): at most about 200 searches from one click, and
// every search goes through the gate in lib/kiwi.ts, which refuses past its daily budget. The
// answer streams progress lines as NDJSON, never silent for more than 15 s, and the finished
// trip is stored for a day. Two visitors asking for the same trip share one build. `fresh`
// only rebuilds when it carries the shared token (ATLAS_FRESH_TOKEN), so a public URL cannot
// be reloaded into hundreds of searches.
export const maxDuration = 300;
const FRESH_HOURS = 24;
const inflight = new InFlight<WildTrip | null>();
const STYLES = ["experiences", "beaches", "food", "cities", "slow"] as const;
const BUDGETS = ["backpacker", "mid", "comfort"] as const;
const TRADEOFFS = ["price", "balanced", "comfort"] as const;
/** The nights a trip may run: lib/wild.ts caps at 90 and scales the nights per stop with it. */
const MIN_NIGHTS = 5;
const MAX_NIGHTS = 90;
/** An explicit departure window is clipped to this many days; lib/wild.ts searches the same ten. */
const MAX_WINDOW_DAYS = 10;
/** Ranked versions per click: three for a normal trip, two past this many nights (each version costs more searches). */
const LONG_TRIP_NIGHTS = 28;
const MAX_VARIANTS = 3;
const MAX_VARIANTS_LONG = 2;
/** The longest flight a traveller may cap a leg at, hours door to door. */
const MAX_FLIGHT_HOURS = 40;
/** Free text is kept short: it goes into two model prompts and a hash of it into the key. */
const MAX_WISHES = 300;

/** `fresh` bypasses the stored trip only with the shared token; without the env it is ignored. */
function freshAllowed(v: string | null): boolean {
  const token = process.env.ATLAS_FRESH_TOKEN?.trim();
  return !!token && !!v && v === token;
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const gateways = iataList(p.get("g"), 3);
  const home = iso2(p.get("home"));
  const regionRaw = (p.get("region") ?? "sea").toLowerCase() as Region;
  const nightsRaw = p.get("nights");
  const nights = intIn(nightsRaw, MIN_NIGHTS, MAX_NIGHTS, 14);
  const monthRaw = p.get("month");
  const month = monthRaw ? (isoMonth(monthRaw) ?? undefined) : undefined;
  // An explicit departure window (from, to) wins over the month; the engine uses [from, min(to, from + 10 days)].
  const fromRaw = p.get("from");
  const toRaw = p.get("to");
  const from = fromRaw ? (isoDay(fromRaw) ?? undefined) : undefined;
  let to = toRaw ? (isoDay(toRaw) ?? undefined) : undefined;
  const style = oneOf<Style>(p.get("style"), STYLES, "experiences");
  const budget = oneOf<Budget>(p.get("budget"), BUDGETS, "mid");
  const at = p.get("lat") != null && p.get("lon") != null ? latLon(p.get("lat"), p.get("lon")) : null;
  const origin = at ? { ...at, label: (p.get("label") ?? "home").slice(0, 60) } : undefined;
  const stopover = p.get("stopover") !== "0";
  const tradeoff = oneOf<Tradeoff>(p.get("tradeoff"), TRADEOFFS, "balanced");
  const noHubs = p.get("noHubs") === "1";
  // Variants are clamped, never refused: a UI that asks for 4 gets the most we allow. The
  // engine (lib/wild-variants.ts) keys every version on the departure window, so a dated
  // request may have ranked versions like any other.
  const variants = Math.min(intIn(p.get("variants"), 1, 4, 1), nights > LONG_TRIP_NIGHTS ? MAX_VARIANTS_LONG : MAX_VARIANTS);
  const exclude = parseExclude(p.get("exclude"));
  // The traveller's own constraints, names or codes anywhere a list is taken.
  const countriesRaw = p.get("countries");
  const countriesParsed = parseCountries(countriesRaw);
  const countries = countriesParsed.codes.length ? countriesParsed.codes.slice(0, 8) : undefined;
  // A country list replaces the region's list whatever region was named: the trip is a custom
  // one (the engine labels and tags it by its countries), stored under the custom key, so
  // "sea plus Portugal and Spain" and "custom Portugal and Spain" are one trip.
  const region: Region = countries && Object.hasOwn(REGIONS, regionRaw) ? "custom" : regionRaw;
  const preferParsed = parseCountries(p.get("prefer"));
  const prefer = preferParsed.codes.length ? preferParsed.codes.slice(0, 8) : undefined;
  const maxStopsRaw = p.get("maxStops");
  const maxStops = maxStopsRaw ? intIn(maxStopsRaw, 1, 8, 0) || undefined : undefined;
  const nightsRangeRaw = p.get("nightsPerStop");
  const nightsRange = nightsRangeRaw ? parseNightsRange(nightsRangeRaw) : null;
  const nightsPerStop = nightsRange ? Math.min(30, nightsRange[0]) : undefined;
  const nightsPerStopMax = nightsRange && nightsRange[1] > nightsRange[0] ? Math.min(30, nightsRange[1]) : undefined;
  const mustRaw = p.get("mustInclude");
  const mustParsed = parseCities(mustRaw);
  const mustInclude = mustParsed.codes.length ? mustParsed.codes.slice(0, 8) : undefined;
  // Read as a plain number, not clamped: 0 or "abc" is a refusal, never a one-hour cap that builds.
  const hoursRaw = p.get("maxFlightHours");
  const hoursNum = hoursRaw ? Number(hoursRaw) : NaN;
  const maxFlightHours = hoursRaw && Number.isFinite(hoursNum) && hoursNum >= 1 && hoursNum <= MAX_FLIGHT_HOURS ? Math.round(hoursNum) : undefined;
  const startFromRaw = p.get("startFrom");
  const startFrom = startFromRaw ? iataList(startFromRaw, 3) : [];
  const wishes = (p.get("wishes") ?? "").trim().slice(0, MAX_WISHES) || undefined;
  if (!gateways.length) return bad("g must be a comma list of three-letter airport codes");
  if (!home) return bad("home must be a two-letter country code");
  // Own keys only: "constructor" is a truthy lookup on any object but no region.
  if (!Object.hasOwn(REGIONS, region)) return bad(`region must be one of ${Object.keys(REGIONS).join(", ")}`);
  if (countriesRaw && !countries) return bad(`none of those is a country we know: ${countriesParsed.unknown.join(", ")} (a name such as Vietnam or a code such as VN)`);
  if (countriesParsed.unknown.length) return bad(`unknown country: ${countriesParsed.unknown.join(", ")} (a name such as Vietnam or a code such as VN)`);
  if (preferParsed.unknown.length) return bad(`unknown country in prefer: ${preferParsed.unknown.join(", ")}`);
  if (region === "custom" && !countries) return bad("region custom needs a countries list (names or codes, for example countries=Vietnam,Thailand)");
  if (mustRaw && !mustInclude) return bad(`unknown city to pass through: ${mustParsed.unknown.join(", ")} (a city name such as Hanoi or a code such as HAN)`);
  if (mustParsed.unknown.length) return bad(`unknown city to pass through: ${mustParsed.unknown.join(", ")}`);
  if (nightsRangeRaw && !nightsRange) return bad("nightsPerStop must be a number or a range such as 3-5");
  if (hoursRaw && !maxFlightHours) return bad(`maxFlightHours must be a number from 1 to ${MAX_FLIGHT_HOURS}`);
  if (startFromRaw && !startFrom.length) return bad("startFrom must be a comma list of three-letter airport codes");
  // A region with every country on the been list has nowhere to stop: say so before any search.
  const regionCountries = countries ?? REGIONS[region].countries.map(([cc]) => cc);
  if (exclude.length && regionCountries.length && regionCountries.every((cc) => exclude.includes(cc))) return bad(`every country of ${countries ? "that list" : REGIONS[region].label} is on your been list; pick another region or allow revisits`);
  if (nightsRaw && !Number.isFinite(Number(nightsRaw))) return bad(`nights must be a number from ${MIN_NIGHTS} to ${MAX_NIGHTS}`);
  if (monthRaw && !month) return bad("month must be YYYY-MM");
  if (month && month < new Date().toISOString().slice(0, 7)) return bad("month is in the past");
  if ((fromRaw && !from) || (toRaw && !to)) return bad("from and to must be real dates, YYYY-MM-DD");
  if (to && !from) return bad("to needs a from");
  if (from && from < new Date().toISOString().slice(0, 10)) return bad("from is in the past");
  if (from && to && to < from) return bad("to must not be before from");
  // A wider window is clipped, not refused: the engine searches ten days at most anyway, and
  // the clipped date is what goes into the stored trip's key, so /api/plan finds it again.
  if (from && to && (Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_WINDOW_DAYS) to = new Date(Date.parse(from) + MAX_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  if ((p.get("lat") != null || p.get("lon") != null) && !at) return bad("lat and lon must be coordinates");

  // The same key /api/plan builds: every constraint through customKey, the variant count as a suffix.
  const extras = { mustInclude, maxFlightHours, startFrom: startFrom.length ? startFrom : undefined, wishes, nightsPerStopMax };
  const path = wildPath(mainGateway(gateways), region, month, nights, style, budget, customKey(countries, prefer, maxStops, nightsPerStop, tradeoff, noHubs, from, to, exclude, extras) + (variants > 1 ? `-v${variants}` : ""));
  if (!freshAllowed(p.get("fresh"))) {
    const stored = await readJson<WildTrip>(path);
    if (stored && stored.ageHours < FRESH_HOURS) return Response.json(stored.body, { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600", "X-Wild": "stored" } });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (obj: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          open = false;
        }
      };
      const alive = keepAlive(send, 15_000, "Still searching fares…");
      const say = (obj: unknown) => {
        alive.touch();
        send(obj);
      };
      const t0 = Date.now();
      const params = { gateways, home, region, month, from, to, nights, style, budget, origin, stopover, exclude, countries, prefer, maxStops, nightsPerStop, nightsPerStopMax, mustInclude, maxFlightHours, startFrom: startFrom.length ? startFrom : undefined, wishes };
      try {
        const { promise, mine } = inflight.run(path, async () => {
          if (variants > 1) {
            say({ progress: `Building ${variants} versions in parallel and ranking them…` });
            const ranked = await buildWildVariants(params, variants, (line) => say({ progress: line }));
            if (!ranked.length) return null;
            const done = { ...ranked[0], alternatives: ranked.slice(1).map((t) => ({ variant: t.variant, rank: t.rank, score: t.score, title: t.title, totals: t.totals, judge: t.judge, outDate: t.outDate, backDate: t.backDate, legs: t.legs, stops: t.stops })) } as WildTrip;
            await writeJson(path, done).catch(() => null);
            return done;
          }
          const trip = await buildWild({ ...params, tradeoff, noHubs, onProgress: (line) => say({ progress: line }) });
          if (!trip) return null;
          say({ progress: "Asking for a second opinion…" });
          const judge = await judgeTrip(trip);
          const done = { ...trip, judge: judge ?? undefined };
          await writeJson(path, done).catch(() => null);
          return done;
        });
        if (!mine) say({ progress: "Someone is building this trip right now; joining them…" });
        const trip = await promise;
        // The usage log, only for the build itself (a joiner did no searches); never awaited.
        // The wishes text stays out of it (free text may carry personal details); its presence is logged.
        if (mine) void logSearch("wild", { gateways, home, region, month, from, to, nights, style, budget, stopover, tradeoff, noHubs, variants, excluded: exclude.length, countries, mustInclude, maxFlightHours, startFrom, wishes: !!wishes }, trip ? 1 + (trip.alternatives?.length ?? 0) : 0, Date.now() - t0).catch(() => null);
        if (trip) say({ trip });
        else say({ error: `No way into ${region === "custom" ? "those countries" : "that region"} on those dates from here${maxFlightHours ? ` under ${maxFlightHours} h a flight` : ""}. Try another month or region.` });
      } catch (err) {
        say({ error: err instanceof Error ? err.message : "the trip search failed" });
      } finally {
        alive.stop();
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Wild": "live" } });
}
