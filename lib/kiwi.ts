// Server-only. Kiwi.com's public MCP server (https://mcp.kiwi.com, no key): live flight
// search with prices and booking links. We speak just enough JSON-RPC over streamable HTTP
// to call its search-flight tool. Results are cached by the caller; the nightly deals ingest
// is the main consumer, the /api/deals route the live one.
const ENDPOINT = "https://mcp.kiwi.com/";
const UA = "atlas travel globe (https://github.com/patrick25076/atlas)";
const HEADERS = { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

export type KiwiLeg = {
  from: string;
  to: string;
  departureTime: string;
  arrivalTime: string;
  durationSeconds: number;
  stops: number;
  route: string[];
  segments: { from: string; to: string; fromCity: string; toCity: string; fromCountry: string; toCountry: string; carrier: string; carrierName: string; flightNumber: string; departureTime: string; arrivalTime: string; durationSeconds: number }[];
};
export type KiwiItinerary = {
  id: string;
  price: number;
  priceFormatted: string;
  totalDurationSeconds: number;
  bookingUrl: string;
  imageId?: string;
  baggage?: { personalItem: number; cabinBag: number; checkedBag: number };
  outbound: KiwiLeg;
  inbound?: KiwiLeg;
};
export type KiwiResult = { query: string; currency: string; resultsCount: number; itineraries: KiwiItinerary[] };

export type SearchArgs = {
  flyFrom: string;
  flyTo: string;
  /** dd/mm/yyyy */
  departureDate: string;
  departureDateTo?: string;
  departureDateFlexDays?: number;
  returnDate?: string;
  returnDateTo?: string;
  returnDateFlexDays?: number;
  adults?: number;
  currency?: string;
};

let session: string | null = null;
let rpcId = 0;

async function post(body: unknown): Promise<{ status: number; sid: string | null; events: Record<string, unknown>[] }> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: session ? { ...HEADERS, "mcp-session-id": session } : HEADERS,
    body: JSON.stringify(body),
  });
  const sid = res.headers.get("mcp-session-id");
  const text = await res.text();
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      events.push(JSON.parse(line.slice(5)));
    } catch {
      // keep-alive or partial line
    }
  }
  return { status: res.status, sid, events };
}

async function ensureSession() {
  if (session) return;
  const id = ++rpcId;
  const init = await post({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "atlas", version: "0.1" } },
  });
  if (init.status !== 200) throw new Error(`kiwi mcp initialize ${init.status}`);
  session = init.sid;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
}

/** dd/mm/yyyy for the Kiwi tool from an ISO date. */
export function kiwiDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

export async function searchFlight(args: SearchArgs): Promise<KiwiResult> {
  await ensureSession();
  const id = ++rpcId;
  const r = await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "search-flight", arguments: { adults: 1, currency: "EUR", ...args } } });
  if (r.status === 404 || r.status === 400) {
    // Session expired: start over once.
    session = null;
    await ensureSession();
    return searchFlight(args);
  }
  const reply = r.events.find((e) => e.id === id) as { result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message: string } } | undefined;
  if (!reply) throw new Error("kiwi mcp: no reply");
  if (reply.error) throw new Error(`kiwi mcp: ${reply.error.message}`);
  const text = reply.result?.content?.find((c) => c.type === "text")?.text ?? "";
  if (reply.result?.isError) throw new Error(`kiwi mcp: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as KiwiResult;
  } catch {
    throw new Error(`kiwi mcp: unexpected answer: ${text.slice(0, 200)}`);
  }
}

/** Nights between the outbound departure and the inbound departure. */
export function nightsOf(it: KiwiItinerary): number | null {
  if (!it.inbound) return null;
  return Math.round((Date.parse(it.inbound.departureTime.slice(0, 10)) - Date.parse(it.outbound.departureTime.slice(0, 10))) / 86_400_000);
}
