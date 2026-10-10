import { priceInsight } from "@/lib/insights";
import { bad, iata, intIn, isoMonth } from "@/lib/params";

// GET /api/insights?src=OTP&dst=BKK&month=2026-11[&price=420][&oneWay=1][&minNights=7&maxNights=14]
// What a route typically costs for a departure month, from every fare anyone on Atlas saw in
// the last 60 days (median of the cheapest per departure date, and the lowest), and with
// price= a verdict: great, good, typical or high. Return fares unless oneWay=1; a nights band
// narrows the history to stays like the one in hand. No database: an honest empty answer.
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const src = iata(p.get("src"));
  const dst = iata(p.get("dst"));
  const month = isoMonth(p.get("month"));
  const priceRaw = p.get("price");
  const price = priceRaw ? Number(priceRaw) : undefined;
  if (!src || !dst) return bad("src and dst must be three-letter airport codes");
  if (!month) return bad("month must be YYYY-MM");
  if (priceRaw && !Number.isFinite(price)) return bad("price must be a number");
  const oneWay = p.get("oneWay") === "1";
  const minNights = p.get("minNights") ? intIn(p.get("minNights"), 0, 365, 0) : undefined;
  const maxNights = p.get("maxNights") ? intIn(p.get("maxNights"), minNights ?? 0, 365, minNights ?? 0) : undefined;
  const r = await priceInsight(src, dst, month, Number.isFinite(price) ? price : undefined, { oneWay, minNights, maxNights });
  if (!r) return Response.json({ src, dst, month, oneWay, typical: null, samples: 0, low: null, verdict: "unknown", note: "no fare memory configured (DATABASE_URL)" }, { headers: { "Cache-Control": "no-store" } });
  return Response.json({ src, dst, month, ...r }, { headers: { "Cache-Control": "public, s-maxage=600" } });
}
