// Server-only. The days of a wild trip, filled in: what you actually do at each stop (the
// loops, cruises, treks and markets a country is known for, from the Wikivoyage guides),
// what and where to eat (the guide's listings plus the model's own knowledge, labelled so),
// what each day costs, and what a month there would cost if you stayed. The model writes
// the plan from that grounding; it does not invent fares or dates.
import { generateObject, jsonSchema } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import countriesJson from "@/public/data/countries.json";
import costsJson from "@/public/data/costs.json";
import { countryGuide, getSights } from "./sights";
import { isNoise, sourcesNear } from "./events/sources";
import { BUDGET_SCALE, type WildTrip } from "./wild";
import type { CountryInfo } from "./types";

const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
const COSTS = costsJson as unknown as Record<string, number>;

export type PlanItem = { when?: string; what: string; kind: "experience" | "food" | "sight" | "move" | "rest" | "tip"; cost?: number; note?: string };
export type PlanDay = { date: string; city: string; title: string; items: PlanItem[] };
export type StopFood = { city: string; country: string; dishes: string[]; where: string[]; dessert?: string; priceNote?: string };
export type StopMonthly = { country: string; city: string; rent: number; food: number; total: number; note?: string };
export type Plan = {
  key: string;
  days: PlanDay[];
  food: StopFood[];
  monthly: StopMonthly[];
  highlights: string[];
  total: number;
  sources: string[];
  generatedAt: string;
};

export function hasPlanner(): boolean {
  return !!process.env.AWS_BEARER_TOKEN_BEDROCK;
}

export async function planDays(trip: WildTrip, key: string): Promise<Plan | null> {
  if (!hasPlanner()) return null;
  const bedrock = createAmazonBedrock({ region: (process.env.AWS_REGION ?? "us-west-2").trim() || "us-west-2", apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK?.trim() });
  const model = bedrock((process.env.ASK_MODEL ?? "us.openai.gpt-6-astra").trim());

  // Grounding: per stop the guide's listings and nearby events during the stay; per country its Do and Eat.
  const countryNames = [...new Set(trip.stops.map((s) => s.country))];
  const [sights, guides] = await Promise.all([
    Promise.all(trip.stops.map((s) => getSights(s.name).catch(() => null))),
    Promise.all(countryNames.map(async (cc) => [cc, await countryGuide(COUNTRIES[cc]?.name ?? cc).catch(() => null)] as const)),
  ]);
  const guideOf = new Map(guides);
  const events = await Promise.all(
    trip.stops.map(async (s) => {
      const near = sourcesNear(s.lat, s.lon);
      const lists = await Promise.all(near.map((src) => src.fetch(s.arrive, s.depart).catch(() => [])));
      return lists
        .flat()
        .filter((e) => !isNoise(e.name, e.kind))
        .slice(0, 5)
        .map((e) => `${e.date} ${e.name}${e.venue ? ` at ${e.venue}` : ""}`);
    }),
  );
  const stops = trip.stops.map((s, i) => ({
    city: s.name,
    country: COUNTRIES[s.country]?.name ?? s.country,
    dates: `${s.arrive} to ${s.depart}`,
    nights: s.nights,
    budgetPerDay: s.perDay,
    priceLevelVsUS: COSTS[s.country] ?? null,
    visa: s.visa ?? undefined,
    guideSee: sights[i]?.see.slice(0, 6).map((x) => `${x.name}${x.desc ? `: ${x.desc.slice(0, 100)}` : ""}`),
    guideDo: sights[i]?.do.slice(0, 5).map((x) => `${x.name}${x.desc ? `: ${x.desc.slice(0, 100)}` : ""}`),
    guideEat: sights[i]?.eat.slice(0, 4).map((x) => `${x.name}${x.desc ? `: ${x.desc.slice(0, 100)}` : ""}`),
    countryDo: guideOf.get(s.country)?.do.slice(0, 6),
    countryEat: guideOf.get(s.country)?.eat.slice(0, 5),
    countryRespect: guideOf.get(s.country)?.respect.slice(0, 2),
    eventsDuringStay: events[i],
  }));
  const legs = trip.legs.map((l) => (l.kind === "fly" ? `${l.date}: fly ${l.fromName} → ${l.toName}, departs ${l.departAt.slice(11, 16)}, arrives ${l.arriveAt.slice(0, 16).replace("T", " ")}, €${l.price}` : `${l.date}: ${l.mode} ${l.fromName} → ${l.toName}, about ${Math.round(l.minutes / 60)} h`));
  const brief = { passport: trip.passport, style: trip.prefs.style, budget: trip.prefs.budget, budgetScale: BUDGET_SCALE[trip.prefs.budget], dates: `${trip.outDate} to ${trip.backDate}`, legs, stops };

  const styleLine: Record<string, string> = {
    experiences: "They want true experiences and memories, not city ticking: the loop, the overnight bus to the mountains, the boat through the caves, the homestay, the market at dawn. Get them out of the big city whenever the nights allow.",
    beaches: "They want beaches and water: swimming, islands, boats, sunsets; cities are for the food and the way in.",
    food: "Food first: markets, the dish the place is known for, where locals eat, one great dinner per stop, desserts and coffee rituals.",
    cities: "They like big cities: neighbourhoods, nightlife, architecture, museums, a proper night out.",
    slow: "Slow travel: fewer plans a day, a rhythm, a cafe to come back to, a day trip rather than three.",
  };
  const schema = jsonSchema<Omit<Plan, "key" | "generatedAt" | "sources">>({
    type: "object",
    properties: {
      highlights: { type: "array", items: { type: "string" }, description: "Three to five lines: the moments this trip is for" },
      days: {
        type: "array",
        description: "One entry per calendar day from the first departure to the last arrival, in order",
        items: {
          type: "object",
          properties: {
            date: { type: "string", description: "YYYY-MM-DD" },
            city: { type: "string" },
            title: { type: "string", description: "A few words for the day" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  when: { type: "string", description: "HH:MM or a part of the day, optional" },
                  what: { type: "string", description: "Concrete and named: the place, the dish, the loop, the bus" },
                  kind: { type: "string", enum: ["experience", "food", "sight", "move", "rest", "tip"] },
                  cost: { type: "number", description: "EUR per person, 0 when free, omit when unknown" },
                  note: { type: "string", description: "Booking, timing or warning in a few words; say 'verify' when from memory rather than the guide" },
                },
                required: ["what", "kind"],
              },
            },
          },
          required: ["date", "city", "title", "items"],
        },
      },
      food: {
        type: "array",
        description: "One per stop city",
        items: {
          type: "object",
          properties: {
            city: { type: "string" },
            country: { type: "string" },
            dishes: { type: "array", items: { type: "string" }, description: "Four to six dishes the place is known for, with a word on each" },
            where: { type: "array", items: { type: "string" }, description: "Two to four places or kinds of places where locals eat well for a fair price: a named market, street, institution; label 'verify' when from memory" },
            dessert: { type: "string", description: "The sweet thing or the coffee ritual to try" },
            priceNote: { type: "string", description: "What a good meal costs there" },
          },
          required: ["city", "country", "dishes", "where"],
        },
      },
      monthly: {
        type: "array",
        description: "One per stop city: what a month there would cost if they stayed",
        items: {
          type: "object",
          properties: {
            country: { type: "string" },
            city: { type: "string" },
            rent: { type: "number", description: "EUR per month, a decent one-bedroom in a central area, at the given budget level" },
            food: { type: "number", description: "EUR per month eating mostly out at local places" },
            total: { type: "number", description: "EUR per month all in: rent, food, local transport, a SIM, going out" },
            note: { type: "string", description: "What moves the number, in a few words" },
          },
          required: ["country", "city", "rent", "food", "total"],
        },
      },
      total: { type: "number", description: "EUR: the sum of the costed items plus nights at the daily budget, excluding flights" },
    },
    required: ["highlights", "days", "food", "monthly", "total"],
    additionalProperties: false,
  });
  try {
    const { object } = await generateObject({
      model,
      schema,
      system: `You plan the days of a multi-country trip for a traveller with a ${trip.passport} passport. ${styleLine[trip.prefs.style]} Budget level: ${trip.prefs.budget}. Use the legs exactly as given for the travel days (times, cities); never change flights. Build each stop from the guide material first (guideDo, countryDo, guideSee, guideEat, countryEat, eventsDuringStay); add your own knowledge of the country's famous experiences and its best-value food when the guide is thin, and mark those items 'verify'. Prefer experiences over sightseeing lists; name real places, loops, markets, dishes. Keep days realistic: arrival days are half days, overnight buses are fine when the style allows, one big thing a day. Costs in euros per person; respect the price level given. Plain words, no hype, no bullet symbols inside strings.`,
      prompt: JSON.stringify(brief),
      maxOutputTokens: 7000,
    });
    return {
      ...object,
      key,
      sources: ["Wikivoyage guides (CC BY-SA 4.0)", ...(events.some((e) => e.length) ? ["city open event feeds"] : []), "the model's own knowledge where marked 'verify'"],
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.log(`plan: ${err instanceof Error ? err.message.slice(0, 300) : err}`);
    return null;
  }
}

export function planPath(wildPath: string): string {
  return wildPath.replace(/^wild\//, "plan/");
}
