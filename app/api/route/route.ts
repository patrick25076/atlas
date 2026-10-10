import { parseExclude } from "@/lib/been";
import { keepAlive } from "@/lib/memo";
import { bad, intIn, isoDay } from "@/lib/params";
import { cheapestWay, type RouteResult } from "@/lib/route-finder";

// GET /api/route?from=Brasov&to=Lisbon&depart=2026-11-14&flex=2&nights=4[&oneWay=1][&maxHours=12]
//     [&exclude=IT][&budget=24]
// The cheapest way from A to B, streamed as NDJSON: {"progress":".."} lines as the engine
// works, {"option":{..}} for every way as it is found, and {"done":{..RouteResult}} last.
// from and to take a city name, an airport code, a place name or "lat,lon". A memo hit
// (the engine keeps an hour, keyed without the budget) is one {"done"} line. At most
// `budget` live Kiwi searches in all (default 24, at most 40; 0 answers from the fare memory
// and the ground graph alone): the main window first, then hubs on two tickets. The budget
// is a ceiling: the same question asked again with a bigger budget streams the stored
// options first and then only the hubs the earlier run left out. exclude is the "Been" list
// (ISO2): never a landing or a night there, fine as a connection. The engine stops issuing
// searches after 90 s and answers with what it has, so the {"done"} line always arrives
// inside maxDuration.
export const maxDuration = 120;

/** What a typed place may look like: letters in any script, digits, spaces and a little punctuation. */
const PLACE = /^[\p{L}\p{N} ,.'()&-]{1,80}$/u;
const MAX_DAYS_OUT = 366;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const from = (p.get("from") ?? "").trim();
  const to = (p.get("to") ?? "").trim();
  const departRaw = p.get("depart");
  const depart = departRaw ? isoDay(departRaw) : null;
  const flex = intIn(p.get("flex"), 0, 3, 2);
  const nights = intIn(p.get("nights"), 1, 60, 4);
  const oneWay = p.get("oneWay") === "1";
  const maxHoursRaw = p.get("maxHours");
  const maxHoursNum = Number(maxHoursRaw);
  const maxHours = maxHoursRaw && Number.isFinite(maxHoursNum) && maxHoursNum > 0 ? Math.min(72, Math.ceil(maxHoursNum)) : undefined;
  const budget = intIn(p.get("budget"), 0, 40, 24);
  const exclude = parseExclude(p.get("exclude"));
  if (!from || !PLACE.test(from)) return bad("from must be a place: a city name, an airport code or lat,lon");
  if (!to || !PLACE.test(to)) return bad("to must be a place: a city name, an airport code or lat,lon");
  if (from.toLowerCase() === to.toLowerCase()) return bad("from and to must be different places");
  if (departRaw && !depart) return bad("depart must be a real date, YYYY-MM-DD");
  const today = new Date().toISOString().slice(0, 10);
  if (depart && depart < today) return bad("depart is in the past");
  if (depart && (Date.parse(depart) - Date.parse(today)) / 86_400_000 > MAX_DAYS_OUT) return bad("depart must be within a year");
  if (maxHoursRaw && !Number.isFinite(maxHoursNum)) return bad("maxHours must be a number of hours");

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
      const alive = keepAlive(send);
      const say = (obj: unknown) => {
        alive.touch();
        send(obj);
      };
      try {
        const result: RouteResult = await cheapestWay({ from, to, depart: depart ?? undefined, flex, nights, oneWay, maxHours, exclude, budget, onProgress: (line) => say({ progress: line }), onOption: (option) => say({ option }) });
        say({ done: result });
      } catch (err) {
        say({ error: err instanceof Error ? err.message : "the route search failed" });
      } finally {
        alive.stop();
        try {
          controller.close();
        } catch {
          // closed by the client
        }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
