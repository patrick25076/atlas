// Small formatters shared by the panel, the top bar and the globe tooltips.
const regionNames = typeof Intl !== "undefined" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;

export function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function dateRange(a: string, b: string): string {
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return `${a} to ${b}`;
  return da.getMonth() === db.getMonth() ? `${da.getDate()} to ${shortDate(b)}` : `${shortDate(a)} to ${shortDate(b)}`;
}

export function weekday(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short" });
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
