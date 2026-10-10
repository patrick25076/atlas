// Hidden gems: places with a lot to see that most people never think of. Fame is English
// Wikipedia page views over a year (public/data/fame.json, with Wikivoyage See and Do counts);
// substance is those listings, World Heritage nearby and cultural places. A gem is substantial
// and below the mass-tourism line, so Sibiu and Matera qualify, Paris and Barcelona never do.
import type { CityPlaces } from "./types";

/** [views over 12 months, Wikivoyage See listings, Do listings]; -1 where unknown. */
export type FameFile = Record<string, [number, number, number]>;

export const FAME_CEILING = 400_000;
export const FAME_FLOOR = 8_000;

export function isGem(fame: FameFile | null, code: string, heritageNearby: number, places?: CityPlaces): boolean {
  const f = fame?.[code];
  if (!f || f[0] < 0) return false;
  const [views, see, doo] = f;
  if (views > FAME_CEILING || views < FAME_FLOOR) return false;
  const listings = Math.max(0, see) + Math.max(0, doo);
  return listings >= 12 || heritageNearby >= 1 || (places?.culture ?? 0) >= 250;
}

/** A short reason, for the card: what makes it a gem. */
export function gemReason(fame: FameFile | null, code: string, heritageNearby: number): string {
  const f = fame?.[code];
  const bits: string[] = [];
  if (heritageNearby) bits.push(heritageNearby === 1 ? "a World Heritage site" : `${heritageNearby} World Heritage sites`);
  if (f && f[1] > 0) bits.push(`${f[1]} things to see`);
  return bits.join(", ");
}
