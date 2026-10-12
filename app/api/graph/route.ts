import { parseExclude } from "@/lib/been";
import { cheapestTrips, everywhere, type EverywhereResult, type TripsResult } from "@/lib/flight-graph";
import { countryGroup } from "@/lib/graph-walk";
import { TtlLru } from "@/lib/memo";
import { bad, iataList, intIn, iso2, isoDay, latLon, oneOf, today } from "@/lib/params";

// GET /api/graph?mode=trips&lat=45.657&lon=25.601&label=Brasov&home=RO&from=2026-10-20&to=2026-10-30
//     &minNights=5&maxNights=6[&nights=2-3][&maxPlaces=3 (1 to 5)][&tradeoff=price][&exclude=HU][&avoid=DE,dach,Berlin]
//     [&ground=330][&g=OTP,GHV]
// GET /api/graph?mode=everywhere&lat=45.657&lon=25.601&label=Brasov&home=RO&depart=2026-10-23[&flex=1]
//     [&back=2026-10-27][&oneWay=1][&exclude=HU][&avoid=DE][&g=OTP,GHV]
// The flight graph (lib/flight-graph.ts, docs/plans/flight-graph.md): Dijkstra on price over the nightly
// one-way edges and the fare memory, no live Kiwi search. trips answers the ten cheapest distinct loops from
// the door and back; everywhere answers every city reachable on a day with its cheapest one-way and, with
// back, its cheapest way home, grouped by country. Prices are up to a day old (three for the fare memory)
// and every flight leg says when it was seen: confirm live before booking. Answers are kept ten minutes per
// normalised question, as long as the graph itself is cached.
export const maxDuration = 60;

const MEMO_TTL_MS = 10 * 60_000;
const MAX_DAYS_OUT = 366;
/**
 * The widest trips question: a window of five weeks and five places. The search is synchronous CPU on a serverless
 * instance and grows with every start day and place, so a wider question is refused up front, not left to run into
 * the library's own stop (which answers, but with "not proven the cheapest").
 */
const MAX_WINDOW_DAYS = 35;
const MAX_PLACES = 5;
const TRADEOFFS = ["price", "balanced", "comfort"] as const;
/** What a label may look like: letters in any script, digits, spaces and a little punctuation. */
const TEXT = /^[\p{L}\p{N} ,.'()&-]{1,80}$/u;
/** One avoid entry: the same, plus the colon of "like:DE". */
const AVOID_ITEM = /^[\p{L}\p{N} .'()&:-]{1,60}$/u;
const memo = new TtlLru<TripsResult | EverywhereResult>(300, MEMO_TTL_MS);

/** The avoid list as the library reads it: groups ("dach", "like:DE", "countries like Germany") expanded to codes. */
function parseAvoid(raw: string | null): string[] | null {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const s = part.trim();
    if (!s) continue;
    if (!AVOID_ITEM.test(s)) return null;
    const group = countryGroup(s);
    if (group) out.push(...group.codes);
    else out.push(s);
    if (out.length > 40) return null;
  }
  return out;
}

/** "2-3" or "2" nights a place, 1 to 14. */
function nightsRange(raw: string | null): [number, number] | null {
  if (raw == null || raw === "") return [2, 3];
  const m = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(raw.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2] ?? m[1]);
  if (a < 1 || b < 1 || a > 14 || b > 14) return null;
  return [Math.min(a, b), Math.max(a, b)];
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const mode = p.get("mode");
  if (mode !== "trips" && mode !== "everywhere") return bad("mode must be trips or everywhere");
  const point = latLon(p.get("lat"), p.get("lon"));
  if (!point) return bad("lat and lon must be a point on Earth");
  const label = (p.get("label") ?? "").trim() || "home";
  if (!TEXT.test(label)) return bad("label must be a short place name");
  const home = iso2(p.get("home"));
  if (!home) return bad("home must be a two-letter country code, such as RO");
  const exclude = parseExclude(p.get("exclude"));
  const avoid = parseAvoid(p.get("avoid"));
  if (!avoid) return bad("avoid must be a short comma list of countries, cities or groups such as dach or like:DE");
  const g = p.get("g");
  const homeAirports = g ? iataList(g, 8) : undefined;
  if (g && !homeAirports?.length) return bad("g must be home airport codes, such as g=OTP,GHV");
  const first = today();
  const last = new Date(Date.now() + MAX_DAYS_OUT * 86_400_000).toISOString().slice(0, 10);
  const origin = { lat: Math.round(point.lat * 1000) / 1000, lon: Math.round(point.lon * 1000) / 1000, label };

  if (mode === "trips") {
    const from = isoDay(p.get("from"));
    const to = isoDay(p.get("to"));
    if (!from || !to) return bad("from and to must be real dates, YYYY-MM-DD");
    if (to < from) return bad("to must not be before from");
    if (from < first) return bad("from is in the past");
    if (to > last) return bad("to is more than a year away");
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_WINDOW_DAYS) return bad(`from and to may be at most ${MAX_WINDOW_DAYS} days apart`);
    const minNights = intIn(p.get("minNights"), 1, 30, 3);
    const maxNights = intIn(p.get("maxNights"), minNights, 30, Math.max(minNights, 7));
    const nights = nightsRange(p.get("nights"));
    if (!nights) return bad("nights must be a number of nights a place, such as 2 or 2-3, 1 to 14");
    const maxPlaces = intIn(p.get("maxPlaces"), 1, MAX_PLACES, Math.max(1, Math.min(MAX_PLACES, Math.ceil(maxNights / nights[0]))));
    if (maxPlaces * nights[1] < minNights) return bad(`${maxPlaces} place${maxPlaces === 1 ? "" : "s"} of at most ${nights[1]} nights cannot fill ${minNights} nights`);
    const tradeoff = oneOf(p.get("tradeoff"), TRADEOFFS, "price");
    const groundMaxMin = intIn(p.get("ground"), 0, 720, 330);
    const key = JSON.stringify(["trips", origin, home, from, to, minNights, maxNights, nights, maxPlaces, tradeoff, groundMaxMin, exclude, avoid, homeAirports ?? []]);
    const hit = memo.get(key);
    if (hit) return Response.json(hit);
    try {
      const r = await cheapestTrips({ origin, homeCountry: home, from, to, minNights, maxNights, nightsPerPlace: nights, maxPlaces, tradeoff, exclude, avoid, groundMaxMin, homeAirports });
      memo.set(key, r);
      return Response.json(r);
    } catch (err) {
      console.log(`graph: trips ${err instanceof Error ? err.message.slice(0, 160) : err}`);
      return Response.json({ error: "the flight graph could not be read right now" }, { status: 503 });
    }
  }

  const depart = isoDay(p.get("depart"));
  if (!depart) return bad("depart must be a real date, YYYY-MM-DD");
  if (depart < first) return bad("depart is in the past");
  if (depart > last) return bad("depart is more than a year away");
  const backRaw = p.get("back");
  const back = backRaw ? isoDay(backRaw) : null;
  if (backRaw && !back) return bad("back must be a real date, YYYY-MM-DD");
  if (back && back < depart) return bad("back must not be before depart");
  const flex = intIn(p.get("flex"), 0, 3, 0);
  const oneWay = p.get("oneWay") === "1" || p.get("oneWay") === "true" || !back;
  const key = JSON.stringify(["everywhere", origin, home, depart, back, flex, oneWay, exclude, avoid, homeAirports ?? []]);
  const hit = memo.get(key);
  if (hit) return Response.json(hit);
  try {
    const r = await everywhere({ origin, homeCountry: home, depart, flex, back: back ?? undefined, oneWay, exclude, avoid, homeAirports });
    memo.set(key, r);
    return Response.json(r);
  } catch (err) {
    console.log(`graph: everywhere ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return Response.json({ error: "the flight graph could not be read right now" }, { status: 503 });
  }
}
