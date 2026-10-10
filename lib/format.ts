// Small formatters shared by the panel, the top bar and the globe tooltips.
const regionNames = typeof Intl !== "undefined" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;

export function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

// A bare YYYY-MM-DD names a calendar day, not an instant. The browser parses it as UTC
// midnight, so a visitor west of Greenwich would see every such date a day early unless it
// is read back in UTC. A full timestamp keeps the visitor's own zone.
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const zoneOf = (iso: string): { timeZone: "UTC" } | Record<string, never> => (DAY_ONLY.test(iso) ? { timeZone: "UTC" } : {});

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...zoneOf(iso) });
}

export function dateRange(a: string, b: string): string {
  // A one-day span (a marathon, a parade) reads as its day, not "11 to 11 Oct".
  if (a === b) return shortDate(a);
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return `${a} to ${b}`;
  const dayOnly = DAY_ONLY.test(a) && DAY_ONLY.test(b);
  const sameMonth = dayOnly ? da.getUTCMonth() === db.getUTCMonth() && da.getUTCFullYear() === db.getUTCFullYear() : da.getMonth() === db.getMonth() && da.getFullYear() === db.getFullYear();
  const firstDay = dayOnly ? da.getUTCDate() : da.getDate();
  return sameMonth ? `${firstDay} to ${shortDate(b)}` : `${shortDate(a)} to ${shortDate(b)}`;
}

export function weekday(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", ...zoneOf(iso) });
}

export function stops(n: number): string {
  return n ? `${n} stop${n === 1 ? "" : "s"}` : "direct";
}

export function changes(n: number | undefined): string {
  return n ? `${n} change${n === 1 ? "" : "s"}` : "direct";
}

export function people(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export function count(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

export function rate(r: number): string {
  return r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(1) : r.toFixed(2);
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  const label = d.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  return y === new Date().getFullYear() ? label : `${label} ${y}`;
}

/** The current month and the next seven, as YYYY-MM. */
export function monthOptions(): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < 8; i++) {
    const x = new Date(Date.UTC(d.getFullYear(), d.getMonth() + i, 1));
    out.push(`${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export function kiwiPhoto(img: string | undefined, size = "600x600"): string | null {
  return img ? `https://images.kiwi.com/photos/${size}/${img}.jpg` : null;
}

/** "Kuala Lumpur" -> "kuala-lumpur", "Brașov" -> "brasov": the slug Kiwi uses for city photos. */
export function citySlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/đ/g, "d")
    .replace(/ł/g, "l")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Kiwi's photo for a city by name and country code. Beware: a city Kiwi has no photo for
 * redirects to one generic placeholder that loads without an error, and the browser hides
 * the redirect, so a caller cannot tell a miss from a hit. Prefer kiwiPhoto with a real
 * image id, or the Wikivoyage thumbnail (components/RouteStrip.tsx StopPhoto).
 */
export function kiwiCityPhoto(name: string, country: string, size = "600x600"): string {
  return `https://images.kiwi.com/photos/${size}/${citySlug(name)}_${country.toLowerCase()}.jpg`;
}

/** Hours with one decimal when short, whole when long: 1.5 h, 14 h. */
export function hoursLabel(h: number): string {
  return h < 10 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h)} h`;
}

/** Days between two ISO dates, never negative. */
export function daysBetween(a: string, b: string): number {
  return Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000));
}

export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
}

/** A Date as YYYY-MM-DD in the visitor's own zone: what a date input or a "today" chip should say. toISOString would give the UTC day, which is tomorrow for an evening in Lisbon and yesterday for a morning in Lima. */
export function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayIso(): string {
  return localIso(new Date());
}

/** Euros as a whole number with a thin space between thousands: €1 250. */
export function euro(n: number): string {
  return `€${Math.round(n).toLocaleString("en-GB").replace(/,/g, " ")}`;
}

/** The flag emoji for an ISO2 country code: two regional indicator symbols. Empty for a bad code. */
export function flagEmoji(cc: string): string {
  const c = cc.toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  return String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65, 0x1f1e6 + c.charCodeAt(1) - 65);
}
