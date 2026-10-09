import { NextResponse } from "next/server";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import dealsJson from "@/public/data/deals.json";
import citiesJson from "@/public/data/cities.json";
import countriesJson from "@/public/data/countries.json";
import cityPlacesJson from "@/public/data/city-places.json";
import weatherJson from "@/public/data/weather.json";
import visaJson from "@/public/data/visa.json";
import { expandWeather, visaFor, type City, type CityPlaces, type CountryInfo, type Deal, type DealsFile, type VisaFile, type WeatherCompact } from "@/lib/types";

// POST /api/ask { question, home?: "RO" } → a short answer grounded in the deals file and the
// place facts, plus the deals it used so the UI can highlight them. Runs on Bedrock with the
// bearer token from the environment (AWS_BEARER_TOKEN_BEDROCK); says so when there is none.
const DEALS = dealsJson as unknown as DealsFile;
const CITIES = citiesJson as unknown as Record<string, City>;
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
const PLACES = cityPlacesJson as unknown as Record<string, CityPlaces>;
const WEATHER = (weatherJson as unknown as WeatherCompact).syms ? expandWeather(weatherJson as unknown as WeatherCompact) : null;
const VISA = visaJson as unknown as VisaFile;

const hits = new Map<string, { n: number; at: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.at > 3_600_000) {
    hits.set(ip, { n: 1, at: now });
    return false;
  }
  h.n++;
  return h.n > 30;
}

function weekendMax(code: string): number | null {
  const days = WEATHER?.cities[code];
  if (!days) return null;
  const d = new Date();
  const toSat = (6 - d.getDay() + 7) % 7;
  const sat = new Date(d.getTime() + toSat * 86_400_000).toISOString().slice(0, 10);
  const sun = new Date(d.getTime() + (toSat + 1) * 86_400_000).toISOString().slice(0, 10);
  const t = days.filter((x) => x.d === sat || x.d === sun).map((x) => x.tmax);
  return t.length ? Math.max(...t) : null;
}

function countryName(code: string): string {
  return COUNTRIES[code]?.name ?? code;
}

export async function POST(request: Request) {
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
    return NextResponse.json({ status: "no-key", note: "The Ask agent needs a model key (AWS_BEARER_TOKEN_BEDROCK, see .env.example).", text: "", used: [] });
  }
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (limited(ip)) return NextResponse.json({ status: "error", note: "Too many questions this hour.", text: "", used: [] }, { status: 429 });

  let body: { question?: string; home?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body with question required" }, { status: 400 });
  }
  const question = (body.question ?? "").trim().slice(0, 400);
  const home = /^[A-Z]{2}$/.test(body.home ?? "") ? body.home! : "RO";
  if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });

  const used = new Map<string, Deal>();
  // Values pasted into env UIs often carry a newline; trim both.
  const bedrock = createAmazonBedrock({
    region: (process.env.AWS_REGION ?? "us-west-2").trim() || "us-west-2",
    apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK?.trim(),
  });
  // Bedrock on-demand needs the cross-region inference profile id, hence the "us." prefix.
  const model = bedrock((process.env.ASK_MODEL ?? "us.openai.gpt-6-astra").trim());

  const tools = {
    cheapest_deals: tool({
      description:
        "Cheapest return getaways from the home airports (real Kiwi.com prices, searched nightly). One result per city. Filter by max price in EUR, nights, direct flights only, warm (>= 20 C this weekend), country code, or a city name.",
      inputSchema: jsonSchema<{ maxPrice?: number; minNights?: number; maxNights?: number; direct?: boolean; warm?: boolean; country?: string; city?: string; limit?: number }>({
        type: "object",
        properties: {
          maxPrice: { type: "number" },
          minNights: { type: "number" },
          maxNights: { type: "number" },
          direct: { type: "boolean" },
          warm: { type: "boolean" },
          country: { type: "string", description: "ISO-2 country code" },
          city: { type: "string" },
          limit: { type: "number", description: "default 8, max 20" },
        },
      }),
      execute: async (a) => {
        const seen = new Set<string>();
        const out: (Deal & { weekendHigh?: number | null; countryName: string })[] = [];
        for (const d of DEALS.deals) {
          if (a.maxPrice != null && d.price > a.maxPrice) continue;
          if (a.minNights != null && d.nights < a.minNights) continue;
          if (a.maxNights != null && d.nights > a.maxNights) continue;
          if (a.direct && d.stops > 0) continue;
          if (a.country && d.country !== a.country.toUpperCase()) continue;
          if (a.city && !d.city.toLowerCase().includes(a.city.toLowerCase())) continue;
          const wk = weekendMax(d.dstCity);
          if (a.warm && (wk ?? -99) < 20) continue;
          if (seen.has(d.dstCity)) continue;
          seen.add(d.dstCity);
          out.push({ ...d, weekendHigh: wk, countryName: countryName(d.country) });
          if (out.length >= Math.min(20, a.limit ?? 8)) break;
        }
        for (const d of out) used.set(`${d.gw}|${d.dst}|${d.out}`, d);
        return out.map((d) => ({
          city: d.city,
          country: d.countryName,
          price: d.price,
          nights: d.nights,
          dates: `${d.out} to ${d.back}`,
          from: d.gw,
          stops: d.stops,
          airline: d.carriers[0],
          flightMinutes: d.outMin,
          weekendHighC: d.weekendHigh,
          key: `${d.gw}|${d.dst}|${d.out}`,
        }));
      },
    }),
    place_facts: tool({
      description: "Facts about a destination city: population, what is there (counts of restaurants, bars, nightlife, culture, nature), currency and rate, plugs, languages, visa for the home passport, travel warning.",
      inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
      execute: async ({ city }) => {
        const q = city.toLowerCase();
        const entry = Object.entries(CITIES).find(([, c]) => c.name.toLowerCase() === q) ?? Object.entries(CITIES).find(([, c]) => c.name.toLowerCase().includes(q));
        if (!entry) return { error: `no city named ${city}` };
        const [code, c] = entry;
        const co = COUNTRIES[c.country];
        return {
          city: c.name,
          country: co?.name ?? c.country,
          population: c.pop,
          places: PLACES[code],
          currency: co?.currency,
          eurRate: co?.rate,
          plugs: co?.plugs,
          voltage: co?.voltage,
          languages: co?.languages,
          visaForHomePassport: c.country !== home ? visaFor(VISA, home, c.country) : "home country",
          travelWarning: co?.advisory?.warning ? "full" : co?.advisory?.partial ? "partial" : "none",
          weekendHighC: weekendMax(code),
        };
      },
    }),
  };

  try {
    const result = await generateText({
      model,
      system: `You are Atlas, a travel concierge for someone living in Romania (passport ${home}). Answer in at most four short sentences, plain words, no bullet lists. Only state prices, dates and facts that the tools returned; never invent a price. Prices are return fares found on Kiwi.com on ${DEALS.updated.slice(0, 10)} and can change. When you recommend deals, name the city, the price and the dates. If nothing in the data fits, say so and suggest the closest thing.`,
      prompt: question,
      tools,
      stopWhen: stepCountIs(4),
      maxOutputTokens: 400,
    });
    return NextResponse.json({ status: "ok", text: result.text, used: [...used.keys()] });
  } catch (err) {
    return NextResponse.json({ status: "error", note: err instanceof Error ? err.message.slice(0, 300) : "ask failed", text: "", used: [] }, { status: 502 });
  }
}
