// Server-only. The second opinion: a model reads a wild trip (every leg priced, every stop
// with its nights, visa and daily budget) and says whether it is worth doing, in plain words,
// with a score, reasons and the two changes that would make it better. Same Bedrock setup as
// the Ask agent; without a key the trip ships unjudged.
import { generateObject, jsonSchema } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { Judge, WildTrip } from "./wild";

export function hasJudge(): boolean {
  return !!process.env.AWS_BEARER_TOKEN_BEDROCK;
}

export async function judgeTrip(trip: WildTrip): Promise<Judge | null> {
  if (!hasJudge()) return null;
  const bedrock = createAmazonBedrock({ region: (process.env.AWS_REGION ?? "us-west-2").trim() || "us-west-2", apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK?.trim() });
  const model = bedrock((process.env.ASK_MODEL ?? "us.openai.gpt-6-astra").trim());
  const brief = {
    from: trip.home,
    passport: trip.passport,
    dates: `${trip.outDate} to ${trip.backDate}`,
    nights: trip.totals.nights,
    legs: trip.legs.map((l) =>
      l.kind === "fly"
        ? `${l.date} fly ${l.fromName} → ${l.toName} €${l.price}, ${l.hours} h, ${l.stops ? `${l.stops} stop via ${l.route.join("-")}` : "direct"}, ${l.carriers.join("+")}`
        : `${l.date} ${l.mode} ${l.fromName} → ${l.toName} ~${Math.round(l.minutes / 60)} h (estimate)`,
    ),
    stops: trip.stops.map((s) => `${s.name}, ${s.country}: ${s.nights} nights, about €${s.perDay}/day for hotel, food, local transport and one activity${s.visa ? `, visa: ${s.visa}` : ""}${s.warning ? ", partial travel warning" : ""}`),
    totals: { ...trip.totals, hoursInTransitDoorToDoor: trip.totals.hoursInAir, hoursInAir: undefined },
    // The traveller's own words and the cities they asked for: the verdict is judged against them.
    travellerWishes: trip.wishes?.trim() ? trip.wishes.trim().slice(0, 300) : undefined,
    askedToPassThrough: trip.mustInclude?.length ? trip.stops.filter((s) => trip.mustInclude!.includes(s.code)).map((s) => s.name) : undefined,
    constraints: trip.constraints?.length ? trip.constraints.slice(0, 6) : undefined,
    note: "Flight hours are door to door including layovers. Living costs are per night, estimated from the country's price level, for hotel, food, local transport and one activity.",
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await judgeOnce(model, brief).catch((err: unknown) => {
      console.log(`judge: ${err instanceof Error ? err.message.slice(0, 300) : err}`);
      return null;
    });
    if (r) return r;
  }
  return null;
}

async function judgeOnce(model: Parameters<typeof generateObject>[0]["model"], brief: unknown): Promise<Judge | null> {
  {
    const { object } = await generateObject({
      model,
      schema: jsonSchema<Judge>({
        type: "object",
        properties: {
          score: { type: "number", description: "0 to 100: how worth doing this exact trip is for a budget traveller who likes variety" },
          verdict: { type: "string", description: "One or two plain sentences, honest, no hype" },
          reasons: { type: "array", items: { type: "string" }, description: "Three short reasons behind the score, good and bad" },
          tweaks: { type: "array", items: { type: "string" }, description: "Two concrete changes that would make it better (skip a stop, add nights, different order), or empty" },
          bestFor: { type: "string", description: "Who this trip suits, in a few words" },
        },
        required: ["score", "verdict", "reasons", "tweaks", "bestFor"],
        additionalProperties: false,
      }),
      system:
        "You judge multi-country budget trips built from real fares. Weigh: price per day against what is seen; hours in the air against nights on the ground; pace (fewer than two nights a stop is rushed; one-stop 20-hour flights are a cost); backtracking; variety (a megacity, a beach, a small town beat three similar cities); season in that month; visa friction and warnings; whether a stop is worth its nights. When travellerWishes is given, judge the trip against those words first (a trip that ignores 'no beaches' or 'temples and street food' loses points, one that delivers them gains); when askedToPassThrough is given, those stops were the traveller's own choice: judge their nights and order, not whether to include them. Be concrete and honest; a weak trip gets a low score and clear tweaks. Prices are euros and were found on Kiwi.com today.",
      prompt: JSON.stringify(brief),
      maxOutputTokens: 600,
    });
    // The model sometimes drops a field or changes its type; a verdict without tweaks is
    // still a verdict, and nothing it sends can crash the parse.
    const score = typeof object?.score === "number" ? object.score : Number(object?.score);
    const verdict = typeof object?.verdict === "string" ? object.verdict.trim() : "";
    if (!Number.isFinite(score) || !verdict) return null;
    const lines = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()).slice(0, n) : []);
    return {
      score: Math.max(0, Math.min(100, Math.round(score))),
      verdict,
      reasons: lines(object.reasons, 4),
      tweaks: lines(object.tweaks, 3),
      bestFor: typeof object.bestFor === "string" ? object.bestFor : "",
    };
  }
}
