// Server-only. A group of friends from different cities, each free on different dates, meet
// somewhere cheap. First the calendar: the windows when everyone is free (and the ones where
// one person arrives a day late or leaves a day early), ranked by length. Then the prices:
// for the best windows, one period search per distinct set of home airports (lib/finder.ts,
// one Kiwi search per target), then a few targeted searches so the cities one group found are
// priced for the others too, and the members' own home cities as hosts (the others fly in,
// the hosts pay nothing). Options are the cities everyone can reach, summed per person.
//
// Bound on live searches, per window: airport groups (at most 4) x targets (at most 4, fewer
// with more groups) + fill-in cities (3, 2 or 1) x groups + host cities (2 or 1) x groups;
// three windows (two with four groups). In practice 25 to 45 searches a request, never more
// than about 55. A region word in `where` ("Europe") becomes its three nearest countries, not
// the finder's eighteen.
import citiesJson from "@/public/data/cities.json";
import { countryAllowed } from "./been";
import { hubDegree, resolveGateway, targetsFor } from "./board";
import { allowedTargets, findDeals, regionCountries } from "./finder";
import { TtlLru } from "./memo";
import type { City, Deal } from "./types";

const CITIES = citiesJson as unknown as Record<string, City>;
const cityOf = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) for (const a of c.airports) cityOf.set(a, code);

export type GroupMember = { name: string; origins: string[]; available: { from: string; to: string }[] };
export type GroupWindow = {
  from: string;
  to: string;
  nights: number;
  everyone: boolean;
  compromises: string[];
  /** Names of the members who are only free from the second day / until the day before the end. */
  late?: string[];
  early?: string[];
};
export type GroupOption = { window: GroupWindow; city: string; country: string; dstCity: string; total: number; perMember: { name: string; price: number; from: string; out: string; back: string; url: string; note?: string }[] };
export type GroupParams = {
  members: GroupMember[];
  minNights: number;
  maxNights: number;
  where?: string;
  direct?: boolean;
  /** "Been" (ISO2): no option in these countries, and a member's home city there is no host option either. */
  exclude?: string[];
  onProgress?: (line: string) => void;
};
export type GroupResult = {
  windows: GroupWindow[];
  options: GroupOption[];
  searched: number;
  /** Searches Kiwi refused after the finder's retries. */
  failed: number;
  /** True when a search failed, so a city may be missing that would otherwise be priced. */
  partial?: true;
  generatedAt: string;
};

/** A request the engine cannot price as asked; the route answers 400 with the message. */
export class GroupInputError extends Error {}

const MAX_GROUPS = 4;
const PER_WINDOW = 10;
const MAX_TARGETS = 4;
const TARGETS_PER_REGION = 3;
const memo = new TtlLru<GroupResult>(100, 30 * 60_000);

// Region words a traveller may type for `where` expand to the finder's list (lib/finder.ts),
// but only the nearest TARGETS_PER_REGION countries are searched, not the finder's eighteen.

const DAY = 86_400_000;
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const isoDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
/**
 * Shaped like a date but not one: "2026-13-01" parses to NaN, "2026-02-31" rolls over to
 * March in V8. Either would make the day loops below misbehave (a RangeError from
 * toISOString, or a window that silently moves), so the engine refuses them as bad input.
 */
const impossibleDay = (s: string) => Number.isNaN(Date.parse(s)) || !new Date(s).toISOString().startsWith(s);
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dm = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]}`;

/** The days a member is free, as a set of ISO dates (ranges are inclusive). */
function freeDays(m: GroupMember): Set<string> {
  const days = new Set<string>();
  for (const w of m.available) {
    if (!isoDay(w.from) || !isoDay(w.to) || w.to < w.from) continue;
    for (let d = w.from; d <= w.to && days.size < 400; d = addDays(d, 1)) days.add(d);
  }
  return days;
}

/** Maximal runs of consecutive days present in every set given. */
function runsOf(sets: Set<string>[]): [string, string][] {
  if (!sets.length) return [];
  const all = [...sets[0]].filter((d) => sets.every((s) => s.has(d))).sort();
  const runs: [string, string][] = [];
  for (const d of all) {
    const last = runs.at(-1);
    if (last && addDays(last[1], 1) === d) last[1] = d;
    else runs.push([d, d]);
  }
  return runs;
}

/**
 * The windows worth pricing: every maximal run everyone is free for, long enough for the
 * nights wanted, then the near misses where exactly one person is away for the first or the
 * last day. Longest first, then the ones with everyone there.
 */
export function groupWindows(members: GroupMember[], minNights: number, maxNights: number): GroupWindow[] {
  const sets = members.map(freeDays);
  const out: GroupWindow[] = [];
  const seen = new Set<string>();
  const push = (from: string, to: string, compromises: string[], late: string[] = [], early: string[] = []) => {
    const nights = daysBetween(from, to);
    if (nights < minNights) return;
    const k = `${from}|${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ from, to, nights: Math.min(nights, maxNights), everyone: !compromises.length, compromises, late: late.length ? late : undefined, early: early.length ? early : undefined });
  };
  for (const [from, to] of runsOf(sets)) push(from, to, []);
  // One person short by a day at either end: the others' run, with that person present for all
  // but its first or last day. The compromise only makes sense when the shorter stay still
  // fits the nights wanted.
  members.forEach((m, i) => {
    const others = sets.filter((_, j) => j !== i);
    if (!others.length) return;
    for (const [from, to] of runsOf(others)) {
      const mine = sets[i];
      const inside = (a: string, b: string) => {
        for (let d = a; d <= b; d = addDays(d, 1)) if (!mine.has(d)) return false;
        return true;
      };
      if (inside(from, to)) continue; // already an everyone window
      if (daysBetween(from, to) - 1 < minNights) continue;
      if (!mine.has(from) && inside(addDays(from, 1), to)) push(from, to, [`${m.name} arrives a day late`], [m.name], []);
      if (!mine.has(to) && inside(from, addDays(to, -1))) push(from, to, [`${m.name} leaves a day early`], [], [m.name]);
    }
  });
  return out.sort((a, b) => b.nights - a.nights || Number(b.everyone) - Number(a.everyone) || a.from.localeCompare(b.from));
}

type Member = GroupMember & { free: Set<string>; homeCities: Set<string> };
type Job = { key: string; origins: string[]; from: string; to: string; deals: Deal[] };

export async function groupTrip(p: GroupParams): Promise<GroupResult> {
  const say = p.onProgress ?? (() => {});
  const usedNames = new Map<string, number>();
  const members: Member[] = p.members
    .slice(0, 8)
    .map((m) => {
      // Names are the keys of every row, so two "Ana"s become "Ana" and "Ana 2".
      const base = m.name.trim().slice(0, 40) || "someone";
      const n = (usedNames.get(base) ?? 0) + 1;
      usedNames.set(base, n);
      const origins = [...new Set(m.origins.map((o) => o.toUpperCase()).filter((o) => /^[A-Z]{3}$/.test(o)))].slice(0, 3);
      const shaped = m.available.filter((w) => isoDay(w.from) && isoDay(w.to)).slice(0, 6);
      const wrong = shaped.flatMap((w) => [w.from, w.to]).find(impossibleDay);
      if (wrong) throw new GroupInputError(`${wrong} is not a real date (${base}); dates must be YYYY-MM-DD and exist in the calendar.`);
      const clean: GroupMember = { name: n > 1 ? `${base} ${n}` : base, origins, available: shaped };
      return { ...clean, free: freeDays(clean), homeCities: new Set(origins.map((o) => cityOf.get(o) ?? o)) };
    })
    .filter((m) => m.origins.length && m.available.length);
  const minNights = Math.max(1, Math.round(p.minNights));
  const maxNights = Math.max(minNights, Math.round(p.maxNights));
  const exclude = p.exclude ?? [];
  const key = JSON.stringify([members.map((m) => [m.name, m.origins, m.available]), minNights, maxNights, p.where?.toLowerCase() ?? "", !!p.direct, exclude]);
  const hit = memo.get(key);
  if (hit) return hit;
  const generatedAt = new Date().toISOString();
  if (members.length < 2) return { windows: [], options: [], searched: 0, failed: 0, generatedAt };

  const windows = groupWindows(members, minNights, maxNights);

  // Origin groups: members who fly from the same airports share one search.
  const groups = new Map<string, { origins: string[]; names: string[] }>();
  for (const m of members) {
    const k = [...m.origins].sort().join(",");
    const g = groups.get(k) ?? { origins: m.origins, names: [] };
    g.names.push(m.name);
    groups.set(k, g);
  }
  if (groups.size > MAX_GROUPS) throw new GroupInputError(`At most ${MAX_GROUPS} different sets of home airports can be priced in one go; this group has ${groups.size}. Put people who can share an airport on the same airports.`);
  // Everyone's windows come before compromises of the same length (sorting did that).
  const toPrice = windows.slice(0, groups.size >= 4 ? 2 : 3);
  if (!toPrice.length) return { windows, options: [], searched: 0, failed: 0, generatedAt };

  // Targets: what the traveller named, bounded, else "anywhere" plus the countries nearest the
  // group's middle. More groups means fewer targets, so the search stays small.
  const pts = members.flatMap((m) => m.origins.map(resolveGateway)).filter((g): g is NonNullable<typeof g> => !!g);
  const lat = pts.reduce((s, g) => s + g.lat, 0) / Math.max(1, pts.length);
  const lon = pts.reduce((s, g) => s + g.lon, 0) / Math.max(1, pts.length);
  // "Been": the visited countries leave the lists before they are cut to two or three, so
  // the few targets priced are the nearest countries the group has not seen.
  const nearCountries = allowedTargets(
    targetsFor(lat, lon, pts[0]?.country ?? "").filter((t) => t !== "anywhere" && /^[A-Za-z]/.test(t) && t.length > 3),
    exclude,
  );
  let where = p.where?.trim() || "";
  // Own keys only (lib/finder.ts regionCountries): "constructor" is not a region.
  const regionList = where ? regionCountries(where) : null;
  if (!where) {
    // The finder caps a comma list at four targets, so "anywhere" plus three nearest countries
    // is the most that is searched; fewer with more airport groups.
    const keep = groups.size <= 2 ? 3 : 2;
    where = ["anywhere", ...nearCountries.slice(0, keep)].join(",");
  } else if (regionList) {
    const allowed = allowedTargets(regionList, exclude);
    // An empty list would read as "anywhere" to the finder, so the answer is a plain refusal.
    if (!allowed.length) throw new GroupInputError(`Every country of ${where} is on your been list (only new countries); pick another region or allow revisits.`);
    const set = new Set(allowed);
    const near = nearCountries.filter((t) => set.has(t));
    where = [...near, ...allowed.filter((t) => !near.includes(t))].slice(0, TARGETS_PER_REGION).join(",");
  } else {
    where = where
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, groups.size >= 3 ? 3 : MAX_TARGETS)
      .join(",");
  }
  // Fill-in and host searches scale down with the number of airport groups.
  const fillN = groups.size <= 2 ? 3 : groups.size === 3 ? 2 : 1;
  const hostN = groups.size <= 2 ? 2 : 1;
  // A host city in a visited country is still someone's home, but the others would sleep
  // there: it stays an option only when its country is allowed.
  const hostCities = [...new Set(members.flatMap((m) => [...m.homeCities]))]
    .filter((c) => CITIES[c] && countryAllowed(CITIES[c].country, exclude))
    .sort((a, b) => hubDegree(b) - hubDegree(a))
    .slice(0, hostN);
  say(`${members.length} people from ${groups.size} airport group${groups.size === 1 ? "" : "s"}, ${toPrice.length} window${toPrice.length === 1 ? "" : "s"} to price…`);

  let searched = 0;
  let failed = 0;
  const options: GroupOption[] = [];
  /** Every day of a trip must be a day that member is free. */
  const withinFree = (m: Member, out: string, back: string) => {
    if (!isoDay(out) || !isoDay(back) || back < out) return false;
    for (let d = out; d <= back; d = addDays(d, 1)) if (!m.free.has(d)) return false;
    return true;
  };
  const byPrice = (a: Deal, b: Deal) => a.price - b.price;

  for (const w of toPrice) {
    say(`Pricing ${w.from} to ${w.to}${w.compromises.length ? ` (${w.compromises.join(", ")})` : ""}…`);
    // One job per (airports, effective window): a late arriver's window starts a day later, an
    // early leaver's ends a day earlier, so nobody is handed a flight on a day they are away.
    const jobs = new Map<string, Job>();
    const jobOf = new Map<string, Job>();
    for (const m of members) {
      const from = w.late?.includes(m.name) ? addDays(w.from, 1) : w.from;
      const to = w.early?.includes(m.name) ? addDays(w.to, -1) : w.to;
      const k = `${[...m.origins].sort().join(",")}|${from}|${to}`;
      let j = jobs.get(k);
      if (!j) {
        j = { key: k, origins: m.origins, from, to, deals: [] };
        jobs.set(k, j);
      }
      jobOf.set(m.name, j);
    }
    const jobList = [...jobs.values()];
    // All jobs at once: the Kiwi gate (lib/kiwi.ts) keeps it to six searches in flight.
    await Promise.all(
      jobList.map(async (j) => {
        const r = await findDeals({ origins: j.origins, from: j.from, to: j.to, minNights, maxNights, where, direct: p.direct, exclude });
        searched += r.searched;
        failed += r.failed;
        j.deals.push(...r.deals);
      }),
    );

    // Fill-in: Kiwi answers with its 15 cheapest per target, so two groups rarely get the same
    // cities. The cities most groups found are priced for the groups that did not, one search
    // each (the city's main airport). Hosts: each member's own city, for the members not living there.
    const found = new Map<string, Set<Job>>();
    for (const j of jobList) for (const d of j.deals) found.set(d.dstCity, (found.get(d.dstCity) ?? new Set()).add(j));
    const fillCities = [...found.entries()]
      .filter(([city, js]) => js.size < jobList.length && CITIES[city]?.airports.length)
      .map(([city, js]) => ({ city, n: js.size, min: Math.min(...jobList.flatMap((j) => j.deals.filter((d) => d.dstCity === city).map((d) => d.price))) }))
      .sort((a, b) => b.n - a.n || a.min - b.min)
      .slice(0, fillN)
      .map((x) => x.city);
    const livesThere = (j: Job, city: string) => j.origins.some((o) => (cityOf.get(o) ?? o) === city);
    const targeted: { j: Job; city: string }[] = [];
    for (const city of [...fillCities, ...hostCities]) for (const j of jobList) if (!found.get(city)?.has(j) && !livesThere(j, city) && !targeted.some((t) => t.j === j && t.city === city)) targeted.push({ j, city });
    if (targeted.length) say(`Pricing ${[...new Set(targeted.map((t) => CITIES[t.city].name))].join(", ")} for everyone…`);
    await Promise.all(
      targeted.map(async ({ j, city }) => {
        const r = await findDeals({ origins: j.origins, from: j.from, to: j.to, minNights, maxNights, where: CITIES[city].airports[0], direct: p.direct, exclude });
        searched += r.searched;
        failed += r.failed;
        j.deals.push(...r.deals.filter((d) => d.dstCity === city));
      }),
    );

    // Options: every city someone found; everyone must have a fare there on their own free
    // days, or live there (a host pays nothing). Everyone on the same dates when possible,
    // else that person's cheapest with a note.
    const perCity: GroupOption[] = [];
    const cities = new Set(jobList.flatMap((j) => j.deals.map((d) => d.dstCity)));
    for (const dstCity of cities) {
      const isHost = hostCities.includes(dstCity);
      const atHome = (m: Member) => isHost && m.homeCities.has(dstCity);
      const dealsFor = (m: Member) => (jobOf.get(m.name)?.deals ?? []).filter((d) => d.dstCity === dstCity && withinFree(m, d.out, d.back)).sort(byPrice);
      if (members.every(atHome)) continue;
      if (!members.every((m) => atHome(m) || dealsFor(m).length)) continue;
      const pairs = new Set<string>();
      for (const m of members) for (const d of dealsFor(m)) pairs.add(`${d.out}|${d.back}`);
      let best: { rows: GroupOption["perMember"]; total: number; score: number } | null = null;
      for (const pair of pairs) {
        const [out, back] = pair.split("|");
        const rows: GroupOption["perMember"] = [];
        let total = 0;
        let mismatches = 0;
        let complete = true;
        for (const m of members) {
          if (atHome(m)) {
            rows.push({ name: m.name, price: 0, from: m.origins[0], out, back, url: "", note: "at home" });
            continue;
          }
          const mine = dealsFor(m);
          const exact = mine.find((d) => d.out === out && d.back === back);
          const d = exact ?? mine[0];
          if (!d) {
            complete = false;
            break;
          }
          if (!exact) mismatches++;
          total += d.price;
          const note = exact ? undefined : w.late?.includes(m.name) && d.out > out ? `arrives ${dm(d.out)}` : w.early?.includes(m.name) && d.back < back ? `leaves ${dm(d.back)}` : `different dates: ${d.out} to ${d.back}`;
          rows.push({ name: m.name, price: d.price, from: d.gw, out: d.out, back: d.back, url: d.url, note });
        }
        if (!complete) continue;
        const score = total + 40 * mismatches;
        if (!best || score < best.score) best = { rows, total, score };
      }
      if (!best) continue;
      const city = CITIES[dstCity];
      perCity.push({ window: w, city: city?.name ?? best.rows.find((r) => r.price > 0)?.from ?? dstCity, country: city?.country ?? "", dstCity, total: Math.round(best.total), perMember: best.rows });
    }
    perCity.sort((a, b) => a.total - b.total);
    options.push(...perCity.slice(0, PER_WINDOW));
  }

  // The same city on the same dates found through two windows is one option: keep the cheapest.
  const unique = new Map<string, GroupOption>();
  for (const o of options) {
    const k = `${o.dstCity}|${o.perMember.map((r) => `${r.name}:${r.out}:${r.back}`).sort().join(";")}`;
    const prev = unique.get(k);
    // Cheapest wins; at the same price the window where everyone is there is the honest label.
    if (!prev || o.total < prev.total || (o.total === prev.total && o.window.everyone && !prev.window.everyone)) unique.set(k, o);
  }
  const ranked = [...unique.values()].sort((a, b) => a.total - b.total);
  const result: GroupResult = { windows, options: ranked, searched, failed, partial: failed > 0 ? true : undefined, generatedAt };
  // An empty answer caused by refused searches is not kept; a retry searches again.
  if (!(failed > 0 && !ranked.length)) memo.set(key, result);
  return result;
}
