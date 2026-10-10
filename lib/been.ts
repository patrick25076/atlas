// "Been": the countries the traveller has already visited, and whether they want only new
// ones. Optional; nothing changes until the visitor marks a country. The list lives in the
// browser (localStorage), rides along as an `exclude` parameter on searches and as a line in
// the chat context. A layover is never excluded: only destinations and overnight stops are,
// because the traveller said a connection through a country they know is fine any time.
// Client-safe: no Node imports.

export type BeenPrefs = {
  /** ISO 3166-1 alpha-2 codes, upper case. */
  countries: string[];
  /** true = only countries not in the list; false = the list is just a record, no filtering. */
  newOnly: boolean;
};

export const BEEN_STORE = "atlas-been-v1";
export const EMPTY_BEEN: BeenPrefs = { countries: [], newOnly: false };
const MAX_COUNTRIES = 200;
const ISO2 = /^[A-Z]{2}$/;

/** Normalises any input into a clean, sorted, de-duplicated ISO2 list. */
export function cleanCodes(raw: unknown, max = MAX_COUNTRIES): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const out = new Set<string>();
  for (const v of list) {
    const code = String(v ?? "")
      .trim()
      .toUpperCase();
    if (ISO2.test(code)) out.add(code);
    if (out.size >= max) break;
  }
  return [...out].sort();
}

export function loadBeen(): BeenPrefs {
  if (typeof window === "undefined") return EMPTY_BEEN;
  try {
    const raw = localStorage.getItem(BEEN_STORE);
    if (!raw) return EMPTY_BEEN;
    const j = JSON.parse(raw) as Partial<BeenPrefs>;
    return { countries: cleanCodes(j.countries), newOnly: j.newOnly === true };
  } catch {
    return EMPTY_BEEN;
  }
}

export function saveBeen(p: BeenPrefs): void {
  try {
    localStorage.setItem(BEEN_STORE, JSON.stringify({ countries: cleanCodes(p.countries), newOnly: p.newOnly === true }));
  } catch {
    // storage off: the preference lives for this page only
  }
}

/** The countries a search must not land in: the list when "only new" is on, otherwise nothing. */
export function excludedCountries(p: BeenPrefs | null | undefined): string[] {
  return p && p.newOnly ? cleanCodes(p.countries) : [];
}

/** The `exclude` query value for the APIs, or undefined when there is nothing to exclude. */
export function excludeParam(p: BeenPrefs | null | undefined): string | undefined {
  const list = excludedCountries(p);
  return list.length ? list.join(",") : undefined;
}

/** Server side: the `exclude` query parameter parsed into codes (bad entries dropped, never a 400). */
export function parseExclude(raw: string | null | undefined): string[] {
  return raw ? cleanCodes(raw) : [];
}

/** True when a destination country is allowed. The home country is the caller's business. */
export function countryAllowed(country: string | undefined, exclude: string[]): boolean {
  if (!exclude.length || !country) return true;
  return !exclude.includes(country.toUpperCase());
}

/** Drops deals landing in an excluded country. Connections through one are untouched. */
export function filterByCountry<T extends { country?: string }>(items: T[], exclude: string[]): T[] {
  return exclude.length ? items.filter((d) => countryAllowed(d.country, exclude)) : items;
}

/** One line for the agent's system prompt. Empty when the feature is off. */
export function beenLine(p: BeenPrefs | null | undefined, countryName: (cc: string) => string = (cc) => cc): string {
  if (!p || !p.countries.length) return "";
  const names = cleanCodes(p.countries).map(countryName);
  const shown = names.length > 25 ? `${names.slice(0, 25).join(", ")} and ${names.length - 25} more` : names.join(", ");
  return p.newOnly
    ? `The traveller has already been to ${shown} and wants only countries they have not seen: never propose a destination or an overnight stop in those countries (pass exclude to every search tool); a layover or connection through them is fine any time.`
    : `The traveller has already been to ${shown}; revisits are fine, but mention when a suggestion is somewhere new to them.`;
}
