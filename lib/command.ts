// The command line: what a traveller types in the top bar (or after `pnpm atlas` in a
// terminal) turned into the few things Atlas can run at once. Pure and client-safe on
// purpose: no data files, no network, no clock (today is passed in), so the browser can
// rank suggestions on every keystroke and the same words give the same answer anywhere.
//
// It never resolves a place: "Brasov" stays the string "Brasov" and the engine that runs
// the command places it (lib/route-finder.ts, lib/itinerary-server.ts). What it does decide
// is the shape: two places joined by "to" are a route, a month or "this weekend" is a
// window, "4 nights" or "a week" is a stay, "carnival" or "jazz festivals" is an event
// search, "/wild sea 21" is a loop. The first suggestion is the best guess; an `ask`
// suggestion (hand the words to the chat agent) always closes the list, and a plain question
// ("is Porto nice in October") is only that.

export type Command =
  | { kind: "route"; from?: string; to: string; depart?: string; nights?: number; oneWay?: boolean; flex?: number; label: string }
  | { kind: "events"; from?: string; to?: string; words?: string[]; where?: string; label: string }
  | {
      kind: "getaways";
      where?: string;
      from?: string;
      to?: string;
      minNights?: number;
      maxNights?: number;
      /** Extra, optional: "under 3h" (flight time) and "under €100" (return fare). */
      maxHours?: number;
      maxPrice?: number;
      label: string;
    }
  | { kind: "wild"; region?: string; countries?: string[]; nights?: number; label: string }
  | { kind: "longstay"; region?: string; countries?: string[]; months?: number; label: string }
  | { kind: "place"; name: string; label: string }
  | {
      kind: "itinerary";
      label: string;
      /** Extra, optional: "itinerary Lisbon 3 nights, Porto 2 nights from 14 Nov" names the
       * stops, the start day and the place to leave from; "/itinerary" alone means "the
       * thing on screen". */
      stops?: { place: string; nights: number }[];
      start?: string;
      from?: string;
    }
  | {
      /** A loop of cheap hops searched the way Skyscanner Explore works (lib/graph-walk.ts): "loop from Brasov
       * 20-30 Oct 6 days", "3 cities in 6 days", "Brasov to Warsaw then train then home". The shell runs it through
       * walkFromCommand in components/Globe.tsx, which builds its own query and dispatches `atlas:walk`;
       * walkCommandQuery in lib/chat-widgets.ts is the same rule as a pure function (scripts/check-tools.ts tests
       * that one, not the shell's); the terminal runs walk_trips. */
      kind: "walk";
      /** Where the loop starts and ends, as typed ("loop from Cluj"); absent means where the traveller is. */
      origin?: string;
      /** The window the whole trip lies in (YYYY-MM-DD); absent means the engine's default (a week out). */
      from?: string;
      to?: string;
      minNights?: number;
      maxNights?: number;
      /** Nights a stop takes: 2, or a range [2, 3]. */
      nightsPerStop?: number | [number, number];
      maxStops?: number;
      /** Cities the loop must pass through, as typed ("Warsaw", "Gdansk"). */
      mustInclude?: string[];
      /** Countries the stops keep to ("loop through Poland 6 days"), as typed. */
      countries?: string[];
      /** "unique" for hidden gems, not touristy, off the beaten track. */
      style?: string;
      /** Places the traveller does not want, as the walk reads them: a country name ("Germany"), "like:DE" for
       * "countries like Germany", or a group word ("dach", "benelux", "nordics"). */
      avoid?: string[];
      label: string;
    }
  | { kind: "ask"; text: string; label: string };

export const COMMAND_HINTS: { example: string; what: string }[] = [
  { example: "Brasov to Lisbon", what: "the cheapest and the fastest way, every kind of ticket" },
  { example: "to Lisbon 14 Nov 4 nights", what: "from where you are, on a day, for a stay" },
  { example: "Bucharest -> Rome one way", what: "one way only" },
  { example: "lisbon in november", what: "the cheapest dates to a place in a month" },
  { example: "events in february", what: "what is worth flying for in a window" },
  { example: "jazz festivals in march", what: "events of a kind" },
  { example: "getaways under 3h this weekend", what: "short trips from your airports" },
  { example: "loop from Brasov 20 to 30 Oct 6 days", what: "a loop of the cheapest hops by plane, train or coach, and home" },
  { example: "3 cities in 6 days, not Germany, unique", what: "a few cities, the cheapest edges first, off the beaten track" },
  { example: "/wild sea 21", what: "a 21 night loop through Southeast Asia" },
  { example: "/stay thailand 2 months", what: "a long stay: bases, rent, flights" },
  { example: "/place Porto", what: "a place: sights, food, what is on, how to get there" },
  { example: "itinerary Lisbon 3 nights from 14 Nov", what: "a day by day plan" },
  { example: "/itinerary", what: "turn what is on screen into a day by day plan" },
];

// ---------------------------------------------------------------------------------------
// Dates. Every date is a calendar day (YYYY-MM-DD); the arithmetic runs on UTC noon so no
// daylight-saving change moves a day.

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MON = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WD = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
const ORD = "(?:st|nd|rd|th)?";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const noon = (day: string) => new Date(day + "T12:00:00Z");
const addDays = (day: string, n: number) => {
  const d = noon(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((noon(b).getTime() - noon(a).getTime()) / 86_400_000);
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const valid = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= monthEnd(y, m);
const monthIndex = (word: string): number => {
  const w = word.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(w)) + 1;
};

/** A window of days, or one day (to === from) when `exact`. */
/** `loose` marks a window that is a period to search in (a month, a week), not the stay itself. */
type Win = { from: string; to: string; exact: boolean; month?: boolean; loose?: boolean };

/** A day with no year written is the next one that is not in the past. */
function nextOccurrence(m: number, d: number, today: string): string | null {
  const y = Number(today.slice(0, 4));
  for (const year of [y, y + 1]) {
    if (!valid(year, m, d)) continue;
    const day = iso(year, m, d);
    if (day >= today) return day;
  }
  return null;
}

/** A whole month (or its first, middle or last third): this year's when it has not ended, else next year's; never before today. */
function monthWindow(m: number, year: number | null, part: string | null, today: string): Win | null {
  const ty = Number(today.slice(0, 4));
  const tm = Number(today.slice(5, 7));
  const y = year ?? (m < tm ? ty + 1 : ty);
  const end = monthEnd(y, m);
  let a = 1;
  let b = end;
  const p = (part ?? "").toLowerCase();
  if (/early|beginning|start/.test(p)) b = 10;
  else if (/mid/.test(p)) [a, b] = [10, 20];
  else if (/late|end/.test(p)) a = 20;
  let from = iso(y, m, a);
  const to = iso(y, m, b);
  if (to < today) return null;
  if (from < today) from = today;
  return { from, to, exact: false, month: !part, loose: true };
}

/** The weekday after today (never today itself): "friday" on a Saturday is six days on. */
function nextWeekday(wd: number, today: string): string {
  const dow = noon(today).getUTCDay();
  return addDays(today, ((wd - dow + 7) % 7) || 7);
}

/** The weekday on or after `day`: "this friday" said on a Friday is that same day. */
function weekdayFrom(wd: number, day: string): string {
  const dow = noon(day).getUTCDay();
  return addDays(day, (wd - dow + 7) % 7);
}

/** "This weekend" from Friday to Sunday: on a Friday or Saturday it starts today, on a Sunday it is next week's. */
function weekend(today: string, next: boolean): Win {
  const dow = noon(today).getUTCDay();
  let fri = dow === 5 ? today : dow === 6 ? today : nextWeekday(5, today);
  const sun = dow === 6 ? addDays(today, 1) : addDays(fri, 2);
  if (next) fri = dow === 5 || dow === 6 ? nextWeekday(5, today) : addDays(fri, 7);
  return next ? { from: fri, to: addDays(fri, 2), exact: false } : { from: fri, to: sun, exact: false };
}

/** One date expression, read whole; null when the words are not one. */
function readTerm(raw: string, today: string): Win | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/,/g, "");
  const one = (day: string | null): Win | null => (day ? { from: day, to: day, exact: true } : null);
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return valid(+m[1], +m[2], +m[3]) ? one(iso(+m[1], +m[2], +m[3])) : null;
  if ((m = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/))) {
    // Day first (European), unless the second number cannot be a month.
    let d = +m[1];
    let mo = +m[2];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return valid(y, mo, d) ? one(iso(y, mo, d)) : null;
    }
    return one(nextOccurrence(mo, d, today));
  }
  if ((m = s.match(new RegExp(`^(\\d{1,2})${ORD} (?:of )?(${MON})(?: (\\d{4}))?$`)))) {
    const mo = monthIndex(m[2]);
    if (m[3]) return valid(+m[3], mo, +m[1]) ? one(iso(+m[3], mo, +m[1])) : null;
    return one(nextOccurrence(mo, +m[1], today));
  }
  if ((m = s.match(new RegExp(`^(${MON}) (\\d{1,2})${ORD}(?: (\\d{4}))?$`)))) {
    const mo = monthIndex(m[1]);
    if (m[3]) return valid(+m[3], mo, +m[2]) ? one(iso(+m[3], mo, +m[2])) : null;
    return one(nextOccurrence(mo, +m[2], today));
  }
  if (s === "today" || s === "tonight" || s === "now" || s === "asap") return one(today);
  if (s === "tomorrow") return one(addDays(today, 1));
  if (s === "day after tomorrow" || s === "the day after tomorrow") return one(addDays(today, 2));
  if (s === "this weekend" || s === "weekend") return weekend(today, false);
  if (s === "next weekend") return weekend(today, true);
  if (s === "this week") return { from: today, to: addDays(today, (7 - noon(today).getUTCDay()) % 7), exact: false, loose: true };
  if (s === "next week") {
    const mon = nextWeekday(1, today);
    return { from: mon, to: addDays(mon, 6), exact: false, loose: true };
  }
  if (s === "this month") return monthWindow(Number(today.slice(5, 7)), Number(today.slice(0, 4)), null, today);
  if (s === "next month") {
    const ty = Number(today.slice(0, 4));
    const tm = Number(today.slice(5, 7));
    return monthWindow(tm === 12 ? 1 : tm + 1, tm === 12 ? ty + 1 : ty, null, today);
  }
  // "next friday" (or "coming friday") is always after today; "friday", "this friday" and
  // "on friday" said on a Friday mean today.
  if ((m = s.match(new RegExp(`^(?:(next|this|coming) )?(${WD})$`)))) {
    const wd = WEEKDAYS.indexOf(m[2]);
    return one(m[1] === "next" || m[1] === "coming" ? nextWeekday(wd, today) : weekdayFrom(wd, today));
  }
  if ((m = s.match(/^in (\d{1,2}|a|one|two|three|four) (days?|weeks?)$/))) {
    const n = numberOf(m[1]) ?? 1;
    return one(addDays(today, /week/.test(m[2]) ? n * 7 : n));
  }
  if ((m = s.match(new RegExp(`^(?:(early|mid|late|end of|beginning of|start of)[ -]?)?(${MON})(?: (\\d{4}))?$`)))) return monthWindow(monthIndex(m[2]), m[3] ? +m[3] : null, m[1] ?? null, today);
  return null;
}

/** Every date expression this parser knows, as one pattern with no capture groups (for finding). */
const TERM = [
  "\\d{4}-\\d{1,2}-\\d{1,2}",
  "\\d{1,2}[./]\\d{1,2}(?:[./]\\d{2,4})?",
  `\\d{1,2}${ORD}\\s+(?:of\\s+)?${MON}(?:,?\\s+\\d{4})?`,
  `${MON}\\s+\\d{1,2}${ORD}(?!\\d)(?:,?\\s+\\d{4})?`,
  "(?:the\\s+)?day\\s+after\\s+tomorrow",
  "today|tonight|tomorrow|asap",
  "(?:this|next)\\s+(?:weekend|week|month)",
  `(?:(?:next|this|coming)\\s+)?${WD}`,
  "in\\s+(?:\\d{1,2}|a|one|two|three|four)\\s+(?:days?|weeks?)",
  `(?:(?:early|mid|late|end\\s+of|beginning\\s+of|start\\s+of)[\\s-]?)?${MON}(?:\\s+\\d{4})?`,
].join("|");

/** A day and a month with no year ("3 jan", "jan 3", "3/1"): the only range end that may roll into next year. */
const DAY_MONTH_RE = new RegExp(`^(?:\\d{1,2}[./]\\d{1,2}|\\d{1,2}${ORD} (?:of )?${MON}|${MON} \\d{1,2}${ORD})$`, "i");
const MONTH_WORD_RE = new RegExp(`\\b${MON}\\b`, "i");

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, couple: 2, "a couple of": 2, few: 3, "a few": 3 };
function numberOf(w: string): number | null {
  const s = w.trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  return NUMBER_WORDS[s] ?? null;
}
const NUM = "(?:\\d{1,3}|a couple of|a few|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|couple|few)";

/** "14 Nov", "14 to 18 Nov", "November", "November 2027": short, for labels. */
function dayLabel(day: string, today: string): string {
  const y = day.slice(0, 4);
  return `${Number(day.slice(8, 10))} ${MONTH_SHORT[Number(day.slice(5, 7)) - 1]}${y !== today.slice(0, 4) ? ` ${y}` : ""}`;
}
function winLabel(w: Win, today: string): string {
  if (w.exact || w.from === w.to) return dayLabel(w.from, today);
  const fm = w.from.slice(0, 7);
  const sameMonth = fm === w.to.slice(0, 7);
  if (w.month && sameMonth) {
    const name = MONTHS[Number(w.from.slice(5, 7)) - 1];
    return `${name[0].toUpperCase()}${name.slice(1)}${w.from.slice(0, 4) !== today.slice(0, 4) ? ` ${w.from.slice(0, 4)}` : ""}`;
  }
  if (sameMonth) return `${Number(w.from.slice(8, 10))} to ${dayLabel(w.to, today)}`;
  return `${dayLabel(w.from, today)} to ${dayLabel(w.to, today)}`;
}

// ---------------------------------------------------------------------------------------
// Words.

const REGION_WORDS: [RegExp, string, string][] = [
  [/\b(?:south[\s-]?east asia|se asia|indochina)\b/, "sea", "Southeast Asia"],
  [/\beast asia\b/, "east-asia", "East Asia"],
  [/\bsouth asia\b/, "south-asia", "South Asia"],
  [/\b(?:central asia|the stans|silk road)\b/, "central-asia", "Central Asia"],
  [/\bcaucasus\b/, "caucasus", "the Caucasus and Turkey"],
  [/\bbalkans?\b/, "balkans", "the Balkans"],
  [/\b(?:north africa|levant|maghreb)\b/, "north-africa", "North Africa and the Levant"],
  [/\b(?:gulf|middle east)\b/, "gulf", "the Gulf"],
  [/\beast africa\b/, "east-africa", "East Africa"],
  [/\bsouthern africa\b/, "southern-africa", "Southern Africa"],
  [/\b(?:central america|north america)\b/, "americas", "North and Central America"],
  [/\bcaribbean\b/, "caribbean", "the Caribbean"],
  [/\b(?:south america|latin america|latam)\b/, "south-america", "South America"],
  [/\b(?:oceania|the pacific|australia and new zealand)\b/, "oceania", "Australia and the Pacific"],
];
/** The region keys the wild engine knows, for "/wild sea 21" written with the key itself. */
const REGION_KEYS: Record<string, string> = { sea: "Southeast Asia", "east-asia": "East Asia", "south-asia": "South Asia", "central-asia": "Central Asia", caucasus: "the Caucasus and Turkey", balkans: "the Balkans", "north-africa": "North Africa and the Levant", gulf: "the Gulf", "east-africa": "East Africa", "southern-africa": "Southern Africa", americas: "North and Central America", caribbean: "the Caribbean", "south-america": "South America", oceania: "Australia and the Pacific" };

/** Words that name a kind of event (the purpose engine matches them against kinds and names). */
const EVENT_WORDS = /\b(carnivals?|festivals?|fests?|fiestas?|marathons?|races?|concerts?|gigs?|parades?|fireworks|lanterns?|oktoberfest|fringe|blossoms?|cherry blossom|northern lights|aurora|christmas markets?|christmas|easter|new year'?s? eve|new year'?s?|nye|hogmanay|diwali|holi|songkran|tomatina|fallas|halloween|day of the dead|pride|grand prix|f1|jazz|techno|opera|film|music|sport|sports|food|beer|wine)\b/g;
const EVENT_TRIGGER = /\b(events?|what'?s on|what is on|whats on|happening|going on|worth (?:flying|travelling|traveling|the trip) for|carnivals?|festivals?|fests?|fiestas?|marathons?|concerts?|gigs?|parades?|fireworks|lanterns?|oktoberfest|fringe|blossoms?|northern lights|aurora|christmas markets?|christmas|easter|new year'?s? eve|new year'?s?|nye|hogmanay|diwali|holi|songkran|tomatina|fallas|halloween|day of the dead|pride|grand prix)\b/i;
const GETAWAY_TRIGGER = /\b(getaways?|get ?away|escapes?|weekend away|city breaks?|short breaks?|breaks?|cheap flights?|deals?|anywhere|somewhere|where can i go|where to go|where should i go|trips? ideas?|cheapest trips?)\b/i;
const WILD_TRIGGER = /\b(loops?|wild|backpack(?:ing)?|grand tour|trip through|tour of|route through|overland|island hopping)\b/i;
const STAY_TRIGGER = /\b(long[\s-]?stay|nomad|digital nomad|live in|living in|winter in|spend the winter|months? in|a month in|work remotely)\b/i;
const ITIN_TRIGGER = /\b(itinerary|itineraries|day[\s-]by[\s-]day|plan (?:my|the|our) (?:days|trip)|plan (?:a|my|our) (?:trip|stay|holiday|weekend)|make it an itinerary|plan it)\b/i;
const ROUTE_TRIGGER = /\b(how (?:do|can|could|would|should) (?:i|we) get|how to get|cheapest way|fastest way|best way|way to get|get (?:me )?to|route from|route to)\b/i;
const QUESTION = /^(is|are|was|were|what|what's|whats|where|when|how|why|which|who|whom|can|could|should|would|will|do|does|did|tell|explain|any|anything|i'm|im|i am|i want|i'd|id|i need|i have|help|please|recommend|suggest|compare|should)\b/i;

/** Words the residue loses at its edges before it is a place: "to Lisbon" is Lisbon. */
const EDGE_WORDS = /^(?:from|to|in|at|for|the|a|an|go|going|fly|flying|flight|flights|trip|travel|visit|cheap|cheapest|me|way|get|and|on|of|around|near)\b\s*/i;
const EDGE_TAIL = /\s*\b(?:please|pls|now|then|and|for|in|on|from|to|at|trip|flights?)$/i;
const NOT_PLACES = new Set(["", "getaway", "getaways", "deals", "escape", "escapes", "break", "breaks", "loop", "wild", "stay", "festival", "festivals", "carnival", "events", "event", "trip", "trips", "flights", "flight", "somewhere", "anywhere", "anything", "cheap", "deals", "deal", "itinerary", "plan", "weekend", "holiday", "vacation", "a", "the", "me", "us", "go", "warm", "sun", "beach"]);

/** "lisbon" reads as Lisbon in a label; a name typed with capitals keeps them (São Paulo, McAllen). */
function titleCase(s: string): string {
  if (s !== s.toLowerCase()) return s;
  return s.replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}
function cleanPlace(raw: string): string {
  let s = raw.replace(/[|?!.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(EDGE_WORDS, "").replace(EDGE_TAIL, "").trim();
    if (s === before) break;
  }
  return titleCase(s);
}
/** True for something that could be a place name: letters (any script), at most four words. */
function placeLike(s: string): boolean {
  if (!s || NOT_PLACES.has(s.toLowerCase())) return false;
  if (!/^[\p{L}][\p{L}\s.'’-]*$/u.test(s)) return false;
  // Search words inside a phrase ("flights only", "cheapest tickets") make it no place.
  if (/\b(?:only|flights?|tickets?|cheapest|direct|nonstop)\b/i.test(s)) return false;
  return s.split(/\s+/).length <= 4;
}

// ---------------------------------------------------------------------------------------
// The reading of one line: dates, stay, flags, then what is left (the places and the verbs).

type Read = {
  win: Win | null;
  nights: number | null;
  /** Nights as a range (a weekend is 2 to 3). */
  nightsRange: [number, number] | null;
  months: number | null;
  flex: number | null;
  oneWay: boolean;
  maxHours: number | null;
  maxPrice: number | null;
  /** The text with every span read above replaced by " | ". */
  rest: string;
};

function readLine(text: string, today: string): Read {
  let w = ` ${text} `;
  const r: Read = { win: null, nights: null, nightsRange: null, months: null, flex: null, oneWay: false, maxHours: null, maxPrice: null, rest: "" };
  const take = (re: RegExp, fn: (m: string[]) => boolean | void) => {
    w = w.replace(re, (...m: unknown[]) => (fn(m.slice(0, -2) as string[]) === false ? (m[0] as string) : " | "));
  };
  take(/\bone[\s-]?way\b|\bsingle(?: ticket)?\b/gi, () => {
    r.oneWay = true;
  });
  take(/\b(?:return|round[\s-]?trip)\b/gi, () => undefined);
  // Words that qualify a trip but are no part of a place: "Lisbon to Porto by train",
  // "Brasov to Lisbon and back". Without this they stay glued to the destination's name.
  take(/\b(?:there and back|(?:and|then) back|both ways)\b/gi, () => undefined);
  take(/\b(?:direct|non[\s-]?stop)(?:\s+flights?)?(?:\s+only)?\b/gi, () => undefined);
  take(/\bby\s+(?:train|rail|bus|coach|car|ferry|boat|plane|air)\b/gi, () => undefined);
  take(/(?:\b(?:under|within|less than|max(?:imum)?|at most|up to)\s+)(\d{1,2}(?:\.\d)?)\s*(?:h|hrs?|hours?)\b(?:\s+(?:flights?|away|flying))?/gi, (m) => {
    r.maxHours = Number(m[1]);
  });
  take(/\b(?:under|below|less than|max(?:imum)?|up to|for under|for less than)\s*(?:€|eur\s*|euros?\s*)?(\d{2,5})\s*(?:€|eur|euros?)?(?=\s|$|[,.!?|])/gi, (m) => {
    r.maxPrice = Number(m[1]);
  });
  take(/(?:\b(?:flex(?:ible)?(?:\s+by)?|give or take)\s*|±\s*|\+\/?-\s*)([0-3])\s*(?:days?)?(?:\s+either side)?\b/gi, (m) => {
    r.flex = Number(m[1]);
  });
  take(/\b([0-3])\s*days?\s+(?:either side|flex(?:ible)?)\b/gi, (m) => {
    r.flex = Number(m[1]);
  });
  // "flexible" with no number: the widest window the route engine takes.
  take(/\b(?:i'?m\s+)?flex(?:ible)?(?:\s+(?:on\s+)?(?:the\s+)?(?:dates?|days?))?\b/gi, () => {
    if (r.flex == null) r.flex = 3;
  });
  // "in 2 weeks" is a day, not a stay: read before the stays.
  take(/\bin\s+(\d{1,2}|a|one|two|three|four)\s+(days?|weeks?)\b/gi, (m) => {
    const win = readTerm(`in ${m[1]} ${m[2]}`, today);
    if (!win || r.win) return false;
    r.win = win;
  });
  // A stay: "4 nights", "for a week", "two weeks", "3 days", "2 months", "a weekend".
  take(new RegExp(`\\b(?:for\\s+)?(${NUM})\\s+(nights?|weeks?|days?|months?)\\b`, "gi"), (m) => {
    const n = numberOf(m[1]);
    if (n == null || n <= 0) return false;
    const unit = m[2].toLowerCase();
    if (unit.startsWith("night")) r.nights = n;
    else if (unit.startsWith("week")) r.nights = n * 7;
    else if (unit.startsWith("day")) r.nights = Math.max(1, n - 1);
    else {
      r.months = n;
      r.nights = n * 30;
    }
  });
  take(/\b(?:for\s+)?(?:a|the)\s+(?:long\s+)?weekend\b(?!\s+away)/gi, (m) => {
    if (/long/i.test(m[0])) r.nightsRange = [3, 4];
    else r.nightsRange = [2, 3];
  });
  // Ranges of dates: "14-18 Nov", "Nov 14-18", "from 14 Nov to 20 Nov", "between March and May".
  take(new RegExp(`\\b(?:from\\s+|between\\s+)?(\\d{1,2})${ORD}\\s*(?:-|–|to|until|till)\\s*(\\d{1,2})${ORD}\\s+(${MON})(?:\\s+(\\d{4}))?\\b`, "gi"), (m) => {
    const a = readTerm(`${m[1]} ${m[3]}${m[4] ? ` ${m[4]}` : ""}`, today);
    if (!a || r.win) return false;
    const mo = Number(a.from.slice(5, 7));
    const y = Number(a.from.slice(0, 4));
    if (!valid(y, mo, Number(m[2])) || Number(m[2]) < Number(m[1])) return false;
    r.win = { from: a.from, to: iso(y, mo, Number(m[2])), exact: false };
  });
  take(new RegExp(`\\b(?:from\\s+|between\\s+)?(${MON})\\s+(\\d{1,2})${ORD}\\s*(?:-|–|to|until|till)\\s*(\\d{1,2})${ORD}\\b`, "gi"), (m) => {
    const a = readTerm(`${m[1]} ${m[2]}`, today);
    if (!a || r.win) return false;
    const mo = Number(a.from.slice(5, 7));
    const y = Number(a.from.slice(0, 4));
    if (!valid(y, mo, Number(m[3])) || Number(m[3]) < Number(m[2])) return false;
    r.win = { from: a.from, to: iso(y, mo, Number(m[3])), exact: false };
  });
  take(new RegExp(`\\b(?:from\\s+|between\\s+)?(${TERM})\\s*(?:-|–|to|until|till|through|and)\\s*(${TERM})\\b`, "gi"), (m) => {
    const a = readTerm(m[1], today);
    const b = readTerm(m[2], today);
    if (!a || !b || r.win) return false;
    const endWords = m[2].trim().toLowerCase().replace(/\s+/g, " ");
    // "friday to sunday": the end weekday is the first one after the start, not after today
    // (read from today, a range starting next Friday would end this Sunday, then a year on).
    const endWd = endWords.match(new RegExp(`^(?:(?:next|this|coming) )?(${WD})$`));
    let to = endWd ? addDays(a.from, ((WEEKDAYS.indexOf(endWd[1]) - noon(a.from).getUTCDay() + 7) % 7) || 7) : b.to;
    // "20 Dec to 3 Jan": only a day and month written without a year rolls into the next year
    // when it would come first; a weekday, "tomorrow" or a written year never does.
    if (to < a.from && DAY_MONTH_RE.test(endWords)) {
      const y = Number(to.slice(0, 4)) + 1;
      to = `${y}${to.slice(4)}`;
    }
    if (to < a.from) return false;
    // A range is a stay or a season to search in: longer than about two months only when one
    // end is written as a date or a month ("today to December", "1 Dec to 1 Mar"); two
    // relative words that span a year are a misreading, not a plan.
    const written = (x: string) => MONTH_WORD_RE.test(x) || /\d/.test(x);
    if (daysBetween(a.from, to) > 62 && !written(m[1]) && !written(m[2])) return false;
    r.win = { from: a.from, to, exact: false, month: !!(a.month && b.month), loose: !!(a.loose || b.loose) };
  });
  // One date or one window: "on 14 Nov", "from 2026-11-14", "in November", "this weekend".
  take(new RegExp(`\\b(?:on\\s+|from\\s+|starting\\s+|start\\s+|departing\\s+|leaving\\s+|in\\s+|around\\s+|by\\s+|for\\s+)?(${TERM})\\b`, "gi"), (m) => {
    const t = readTerm(m[1], today);
    if (!t || r.win) return false;
    r.win = t;
  });
  // A bare "weekend" ("weekend in Rome") is a stay of two or three nights.
  take(/\bweekend\b(?!\s+away)/gi, () => {
    if (r.nightsRange) return false;
    r.nightsRange = [2, 3];
  });
  r.rest = w;
  return r;
}

/** Words that make a phrase a kind of search, never one end of a route ("loop through Vietnam"). */
const notAnEnd = (s: string) => WILD_TRIGGER.test(s) || STAY_TRIGGER.test(s) || GETAWAY_TRIGGER.test(s) || ITIN_TRIGGER.test(s);

/**
 * The parts of the residue joined by an arrow or "to": the two ends of a route. A chain
 * ("Rome to Paris to London") keeps its first two places as the route and the rest in
 * `more`, for an itinerary; "Lisbon from Brasov" names the destination first.
 */
function splitRoute(rest: string): { from?: string; to: string; more?: string[] } | null {
  const flat = rest.replace(/\s*\|\s*/g, " | ");
  const ends = (parts: string[]): { from?: string; to: string; more?: string[] } | null => {
    if (parts.length < 2) return null;
    const [from, to, ...more] = parts.map(cleanPlace);
    if (!placeLike(to) || (from && !placeLike(from)) || !more.every(placeLike)) return null;
    if (parts.some((x) => notAnEnd(x))) return null;
    return { ...(from ? { from } : {}), to, ...(more.length ? { more: more.slice(0, 6) } : {}) };
  };
  const arrow = flat.split(/\s*(?:->|→|=>|—>|–>|>)\s*|\s+[-–]\s+/);
  if (arrow.length >= 2) {
    const e = ends(arrow);
    if (e) return e;
  }
  const m = flat.match(/^(.*?)\bto\b(.*)$/i);
  if (m) {
    const e = ends([m[1].replace(/^.*\bfrom\b/i, ""), ...m[2].split(/\bto\b/i)]);
    if (e) return e;
  }
  const back = flat.match(/^(.*?)\bfrom\b(.*)$/i);
  if (back && cleanPlace(back[1]) && cleanPlace(back[2])) {
    const e = ends([back[2], back[1]]);
    if (e && e.from && !e.more) return e;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Walks: a loop of cheap hops (lib/graph-walk.ts), searched the way the owner does it by hand
// with Skyscanner Explore. "loop from Brasov 20-30 Oct 6 days", "3 cities in 6 days", "Brasov
// to Warsaw then train then home", "cheap unique loop next month not germany".

/** Words that ask for a loop of hops rather than one trip: a loop, a number of cities, nights a
 * stop, or a chain of hops written out ("plane then train", "then another city", "then home").
 * "Rome to Paris then back" stays a return route: "then back" alone is no chain. */
const WALK_TRIGGER = /\b(?:loops?|circuit|multi[\s-]?city|city[\s-]?hop(?:ping)?|(?:\d|two|three|four|five|six|a few|few)\s+(?:cities|stops|towns|places)|(?:nights?|days?)\s+(?:a|per|each|in each|at each|for each)\s+(?:stop|city|town|place)|then\s+(?:by\s+)?(?:train|rail|coach|bus|plane|fly|flight|ferry|home|another)|back home|come back from|plane then train|train then plane|(?:plane|train|coach|bus|flight|ferry)s?\s*,?\s*then|to another (?:city|place|town))\b/i;
/** Words that make a loop the wild engine's (a far region, weeks overland), not the walk's. "through" and
 * "across" are read apart: "loop through Poland 6 days" is a walk kept to Poland; a far country or two weeks
 * or more is Wild's. */
const WILD_ONLY = /\b(?:wild|backpack(?:ing)?|overland|grand tour|island hopping|through|across)\b/i;
/** A two-part name that is one place, never an A-B pair of two ("Cluj-Napoca", "Saint-Malo", "Baden-Baden"). */
const ONE_PLACE_PAIR = /^(?:cluj-napoca|baden-baden|bielsko-biala|bielsko-biała|gorzow-wielkopolski|castellon-de|sankt-\S+|saint-\S+|sainte-\S+|st-\S+|san-\S+|santa-\S+|santo-\S+|sao-\S+|são-\S+|le-\S+|la-\S+|les-\S+|el-\S+|al-\S+|bad-\S+|port-\S+|porto-\S+|aix-\S+|villa-\S+|ciudad-\S+|nieuw-\S+|new-\S+)$/i;
/** A kind of hop written next to a pair ("Brasov-Warsaw plane", "by train Warsaw-Gdansk"). */
const HOP_WORD = "(?:by\\s+)?(?:planes?|fly|flights?|train|trains|rail|coach|bus|ferry|car)";
/** Who comes along is not a stop: "with my partner", "with kids". */
const NOT_A_STOP = /^(?:my|our|a|an|the|kids|children|family|friends?|wife|husband|partner|girlfriend|boyfriend|baby|dog|parents|mum|mom|dad|budget|luggage|bags?|hand luggage|backpack|car|time)\b/i;
/** "Cheap but unique": the walk's style that weights hidden gems up and the biggest hubs down. */
const STYLE_UNIQUE = /\b(?:unique|hidden gems?|not (?:too )?touristy|less touristy|untouristy|off the beaten (?:path|track)|smaller (?:cities|places|towns)|offbeat|lesser[\s-]known|not mainstream)\b/gi;
/** The countries people compare others to ("countries like Germany"), as the code the walk's like: rule takes.
 * A short list on purpose: this file has no data files; a name not here goes through as written. */
const COUNTRY_ISO: Record<string, string> = { germany: "DE", austria: "AT", switzerland: "CH", netherlands: "NL", holland: "NL", belgium: "BE", luxembourg: "LU", france: "FR", italy: "IT", spain: "ES", portugal: "PT", poland: "PL", "united kingdom": "GB", uk: "GB", britain: "GB", england: "GB", ireland: "IE", denmark: "DK", sweden: "SE", norway: "NO", finland: "FI", czechia: "CZ", "czech republic": "CZ", slovakia: "SK", hungary: "HU", greece: "GR", turkey: "TR", romania: "RO", bulgaria: "BG", croatia: "HR", serbia: "RS", slovenia: "SI" };
/** Group words the walk reads as several countries at once, as the word lib/graph-walk.ts's countryGroup knows
 * (its GROUP_WORDS); the key is what people type, the value what the walk is sent. */
const AVOID_GROUPS: Record<string, string> = { dach: "dach", germanic: "dach", "german speaking": "dach", benelux: "benelux", "low countries": "benelux", nordics: "nordics", nordic: "nordics", scandinavia: "nordics", scandinavian: "nordics", baltics: "baltics", baltic: "baltics", "baltic states": "baltics", balkans: "balkans", balkan: "balkans", iberia: "iberia", iberian: "iberia", "british isles": "british isles" };
/** How a group word reads in a label. */
const GROUP_LABEL: Record<string, string> = { dach: "the DACH countries", benelux: "Benelux", nordics: "the Nordics", baltics: "the Baltics", balkans: "the Balkans", iberia: "Iberia", "british isles": "the British Isles" };
/** What can follow "not" or "no" without being a place: "not touristy", "no night flights", "no big cities",
 * "not by plane" (a way to travel, read apart below). */
const NOT_AVOIDABLE = /^(?:touristy|too|expensive|far|long|more|big|crowded|night|nights|overnight|flights?|trains?|coach(?:es)?|bus(?:es)?|hubs?|layovers?|stops?|cities|city|hostels?|early|late|the|a|an|much|cheap|stress|rush|change|changes|connections?|by|via|planes?|fly|flying|car|cars|ferry|ferries|driving|ground|air)$/i;
/** "not Germany", "no Austria or Switzerland", "nothing like Germany", "I don't like countries like Germany". The
 * name runs to a separator, a date word or a number. */
const AVOID_RE = /\b(?:not|no|avoid(?:ing)?|without|except|skip(?:ping)?|nothing|nowhere|i (?:do not|don'?t) like|hate)\s+(?:(?:countries|places|anywhere|somewhere)\s+)?(like\s+)?([\p{L}][\p{L} .'-]*?)(?=\s*(?:[,;.!?|]|$|\b(?:in|from|next|this|with|for|on|between|under|by|please|then|loop|starting|leaving|around|during)\b|\d))/giu;
/** Words a walk line carries that are no place: the kinds of hop, the filler of a spoken chain. */
const WALK_FILLER = /\b(?:loops?|circuit|multi[\s-]?city|city[\s-]?hop(?:ping)?|hopping|cheap(?:est)?|cheaper|but|also|planes?|trains?|rail|coach|bus|fly|flights?|ferry|home|back|another (?:city|place|town|stop)|then|by|way|maybe|i'?d|i would|i|have|had|done|did|that|this|it|do|go|come|would|could|trip|route|days?|nights?)\b/gi;

/**
 * The places of a walk line, once dates, stays and wishes are gone: where it starts and the cities it must pass.
 * The first place is the start only when the chain begins with one ("Brasov to Warsaw", "Brasov-Warsaw plane");
 * a chain that begins with a hop ("fly to Warsaw", "Warsaw by plane then train to Gdansk") starts where the
 * traveller is, and every place in it is a stop. Starting from a stop would make a loop that can never close:
 * the walk never stops in its own start country. "back to Brasov or Sibiu" names the ways home, never stops;
 * "come back from Gdansk", "with Krakow", "via Krakow" and "Warsaw and Gdansk" name stops.
 */
function walkPlaces(text: string): { origin?: string; mustInclude: string[] } {
  let rest = ` ${text} `;
  // A-B pairs: "Brasov - Warsaw" always, "Brasov-Warsaw" when a hop is written next to it or the line chains two
  // pairs; a name that is one place ("Cluj-Napoca") never splits.
  rest = rest.replace(/([\p{L}.'])\s+[-–]\s+(?=\p{L})/gu, "$1 -> ");
  const pairRe = /(^|[\s|,;(])(\p{L}[\p{L}'.]+)[-–](\p{L}[\p{L}'.]+)(?=$|[\s|,;)])/gu;
  const pairs = [...rest.matchAll(pairRe)].filter((m) => !ONE_PLACE_PAIR.test(`${m[2]}-${m[3]}`));
  const hopAfter = new RegExp(`^\\s*,?\\s*${HOP_WORD}\\b`, "i");
  const hopBefore = new RegExp(`\\b${HOP_WORD}\\s*$`, "i");
  if (pairs.length) {
    const split = new Set(pairs.filter((m) => pairs.length >= 2 || hopAfter.test(rest.slice(m.index! + m[0].length)) || hopBefore.test(rest.slice(0, m.index! + m[1].length))).map((m) => m.index!));
    rest = rest.replace(pairRe, (all: string, pre: string, a: string, b: string, at: number) => (split.has(at) ? `${pre}${a} -> ${b}` : all));
  }
  const must: string[] = [];
  const add = (raw: string) => {
    for (const part of raw.split(/\s*(?:,|&|\+|\band\b)\s*/i)) {
      if (NOT_A_STOP.test(part.trim())) continue;
      const name = cleanPlace(part.replace(WALK_FILLER, " "));
      if (placeLike(name) && !must.includes(name)) must.push(name);
    }
  };
  const END = String.raw`(?=\s*(?:\||,|;|$|->|→|\bthen\b|\bwith\b|\bvia\b|\bto\b))`;
  // "come back from Gdansk", "fly back from Gdansk": the city the way home leaves from is a stop.
  rest = rest.replace(new RegExp(String.raw`\b(?:back|return(?:ing)?)\s+from\s+([^|,;]+?)` + END, "gi"), (_all: string, p: string) => (add(p), " | "));
  // "with Krakow", "via Krakow", "including Krakow and Gdansk": stops. "with my partner" is no place.
  rest = rest.replace(new RegExp(String.raw`\b(?:with|via|including|plus)\s+([^|,;]+?)` + END, "gi"), (all: string, p: string) => {
    const before = must.length;
    add(p);
    return must.length > before ? " | " : all;
  });
  // "back to Brasov or Sibiu or Otopeni", "home to Bucharest": the ways home, which are the traveller's airports.
  rest = rest.replace(/\b(?:back|home|return(?:ing)?)\s+to\s+[^|,;]+/gi, " | ");
  // "from X" ends at the next separator, "and", "then", "with", "via" or "to": "go from Brasov and come back".
  let origin: string | undefined;
  rest = rest.replace(/\bfrom\s+([^|,;]+?)(?=\s*(?:\||,|;|$|->|→|\band\b|\bthen\b|\bwith\b|\bvia\b|\bto\b))/i, (all: string, p: string) => {
    const name = cleanPlace(p.replace(WALK_FILLER, " "));
    if (!placeLike(name)) return all;
    origin = name;
    return " | ";
  });
  const places: string[] = [];
  const chain = /\bto\b|->|→/i.test(rest);
  // No chain, but names joined by "and": "multi city trip Warsaw and Gdansk".
  const joined = !chain && /\p{L}\s+(?:and|&)\s+\p{L}/iu.test(rest);
  if (chain || joined) {
    for (const seg of rest.split(/\s*(?:\||,|;|->|→|\bto\b|\bthen\b|\band\b|&)\s*/i)) {
      // "Brasov or Bucharest": a choice of ways home, not stops.
      if (/\bor\b/i.test(seg)) continue;
      const name = cleanPlace(seg.replace(WALK_FILLER, " "));
      if (placeLike(name) && !places.includes(name)) places.push(name);
    }
  }
  if (chain && !origin) {
    // The chain's head: what comes before its first "to" or arrow, after the last separator. A place there is
    // where the loop starts ("Brasov to Warsaw"); a hop word or nothing ("fly to", "Warsaw by plane then train
    // to") means the chain starts where the traveller is.
    const head = rest.split(/\bto\b|->|→/i)[0].split(/\s*(?:\||,|;|\bthen\b|\band\b)\s*/i).at(-1) ?? "";
    const name = cleanPlace(head.replace(WALK_FILLER, " "));
    if (!new RegExp(`\\b${HOP_WORD}\\b`, "i").test(head) && placeLike(name)) origin = name;
  }
  for (const p of places) if (!must.includes(p)) must.push(p);
  return { ...(origin ? { origin } : {}), mustInclude: must.filter((p) => p !== origin).slice(0, 5) };
}

/** A loop of hops, or null when the line is not one (no walk words, a far region, weeks overland). */
function readWalk(raw: string, today: string): Extract<Command, { kind: "walk" }> | null {
  if (!WALK_TRIGGER.test(raw)) return null;
  let w = ` ${raw} `;
  // The walk's own phrases first, so the date and stay reader below never sees "2 nights a stop" as the stay.
  let nps: number | [number, number] | undefined;
  const npsOf = (a: string, b?: string) => {
    const x = numberOf(a);
    const y = b ? numberOf(b) : null;
    if (x == null || x < 1 || x > 14) return;
    nps = y != null && y > x && y <= 14 ? [x, y] : x;
  };
  w = w.replace(/\b(\d{1,2}|one|two|three|four|a couple of)(?:\s*(?:-|–|to)\s*(\d{1,2}))?\s+(?:nights?|days?)\s+(?:a|per|each|in each|at each|for each)\s+(?:stop|city|town|place)\b/i, (_all, a: string, b?: string) => (npsOf(a, b), " | "));
  if (nps == null) w = w.replace(/\b(\d{1,2}|one|two|three|four)(?:\s*(?:-|–|to)\s*(\d{1,2}))?\s+(?:nights?|days?)\s+each\b/i, (_all, a: string, b?: string) => (npsOf(a, b), " | "));
  let range: [number, number] | undefined;
  w = w.replace(/\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+(nights?|days?)\b/i, (all, a: string, b: string, unit: string) => {
    const x = Number(a);
    const y = Number(b);
    if (!(y >= x && x >= 1 && y <= 60)) return all;
    range = /^day/i.test(unit) ? [Math.max(1, x - 1), Math.max(1, y - 1)] : [x, y];
    return " | ";
  });
  let maxStops: number | undefined;
  w = w.replace(/\b(\d|two|three|four|five|six|a few|few)\s+(?:cities|stops|towns|places)\b/i, (_all, n: string) => {
    const k = /few/.test(n) ? 3 : numberOf(n);
    if (k != null && k >= 1 && k <= 6) maxStops = k;
    return " | ";
  });
  let style: string | undefined;
  w = w.replace(STYLE_UNIQUE, () => ((style = "unique"), " | "));
  const avoid: string[] = [];
  w = w.replace(AVOID_RE, (all, like: string | undefined, names: string) => {
    const got: string[] = [];
    for (const part of names.split(/\s*(?:,|\/|&|\bor\b|\band\b)\s*/i)) {
      // "not via Munich" is Munich; "not by plane" is a way to travel, which the walk does not take as a wish.
      let n = part.trim().toLowerCase().replace(/^the\s+/, "").replace(/^(?:via|through|in|to)\s+/, "").replace(/^the\s+/, "");
      if (/^(?:by|on|using)\b/.test(n)) continue;
      // "the dach countries", "nordic countries", "the balkan region": the group word without its tail.
      const bare = n.replace(/\s+(?:countries|country|region|area|states)$/, "");
      const group = AVOID_GROUPS[n] ?? AVOID_GROUPS[bare];
      if (group) {
        got.push(group);
        continue;
      }
      n = bare || n;
      if (!n || NOT_AVOIDABLE.test(n) || n.split(/\s+/).length > 3) continue;
      if (like) got.push(`like:${COUNTRY_ISO[n] ?? titleCase(n)}`);
      else if (placeLike(titleCase(n))) got.push(titleCase(n));
    }
    if (!got.length) return all;
    for (const g of got) if (!avoid.includes(g)) avoid.push(g);
    return " | ";
  });
  // "through Poland", "across Italy": a European country the walk keeps to. Any other "through" (a far country,
  // a region, a city) is left for the wild engine below.
  let countries: string[] | undefined;
  w = w.replace(/\b(?:through|across|around|in)\s+(?:the\s+)?([\p{L}][\p{L} ]*?)(?=\s*(?:[|,;.!?]|$|\d|\b(?:in|for|from|next|this|with|then|and|on|over|within|during|starting|leaving|not|no|but)\b))/giu, (all, name: string) => {
    const n = name.trim().toLowerCase();
    if (!COUNTRY_ISO[n]) return all;
    (countries ??= []).push(titleCase(n));
    return " | ";
  });
  // A far region or weeks overland is the wild engine's loop ("Balkans loop 10 nights" stays wild).
  const lowerLeft = w.toLowerCase();
  if (REGION_WORDS.some(([re]) => re.test(lowerLeft)) || WILD_ONLY.test(lowerLeft)) return null;
  // "3 cities in 6 days" is how long, not when: for a walk, "in N days" is the stay ("in 2 weeks" stays a date).
  w = w.replace(/\b(?:in|over|within)\s+(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+(days?)\b/gi, " $1 $2 ");
  const r = readLine(w, today);
  // The stay: a range read above, else the reader's nights ("6 days" is 5 to 6 nights: the day you fly home counts).
  const daysSaid = /\b(?:\d{1,2}|a|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\b/i.test(w) && !/\bnights?\b/i.test(w);
  const nights: [number, number] | undefined = range ?? (r.nights != null ? (daysSaid ? [r.nights, r.nights + 1] : [r.nights, r.nights]) : (r.nightsRange ?? undefined));
  if (nights && nights[1] > 21) return null;
  // Two weeks or more kept to one country is a long trip through it: the wild engine's ("loop through Poland 3 weeks").
  if (countries && nights && nights[0] >= 14) return null;
  const { origin, mustInclude } = walkPlaces(r.rest);
  const win = r.win;
  const from = win?.from;
  const to = win && !win.exact ? win.to : undefined;
  const avoidLabel = avoid.map((a) => (a.startsWith("like:") ? `nothing like ${ISO_NAME[a.slice(5)] ?? a.slice(5)}` : `not ${GROUP_LABEL[a] ?? a}`)).join(", ");
  const npsLabel = nps == null ? "" : Array.isArray(nps) ? `${nps[0]} to ${nps[1]} nights a stop` : `${nps} night${nps === 1 ? "" : "s"} a stop`;
  const label = [
    `A loop${origin ? ` from ${origin}` : ""}${mustInclude.length ? ` through ${mustInclude.join(", ")}` : ""}${countries ? ` in ${countries.join(", ")}` : ""}`,
    win ? `${win.month ? "in " : ""}${winLabel(win, today)}` : "",
    nights ? `${nights[0] === nights[1] ? nights[0] : `${nights[0]} to ${nights[1]}`} nights` : "",
    npsLabel,
    maxStops ? `up to ${maxStops} stops` : "",
    avoidLabel,
    style ? "off the beaten track" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return {
    kind: "walk",
    ...(origin ? { origin } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(nights ? { minNights: nights[0], maxNights: nights[1] } : {}),
    ...(nps != null ? { nightsPerStop: nps } : {}),
    ...(maxStops ? { maxStops } : {}),
    ...(mustInclude.length ? { mustInclude } : {}),
    ...(countries ? { countries } : {}),
    ...(style ? { style } : {}),
    ...(avoid.length ? { avoid } : {}),
    label,
  };
}
/** The country names the like: codes stand for, for labels. */
const ISO_NAME: Record<string, string> = Object.fromEntries(Object.entries(COUNTRY_ISO).map(([n, c]) => [c, titleCase(n)]));

type Stops = {
  stops: { place: string; nights: number }[];
  start?: string;
  from?: string;
  /** How many stops named their stay with a unit ("3 nights", "a week"). */
  explicit: number;
  /** How many named it with a bare number ("Porto 2"). */
  bare: number;
};

/** "Lisbon 3 nights, Porto 2 nights" or "3 nights in Lisbon then 2 in Porto": the stops of an itinerary. */
function readStops(text: string, today: string): Stops {
  let w = ` ${text} `.replace(/\/(?:itinerary|itin|i|plan)\b/i, " ");
  // Only the verbs go: "a" and "an" stay, because "Venice a week" needs its "a".
  w = w.replace(ITIN_TRIGGER, " ").replace(/\b(?:make|build|plan|create|me|please)\b/gi, " ");
  let start: string | undefined;
  w = w.replace(new RegExp(`\\b(?:from|on|starting|start|leaving|departing)\\s+(${TERM})\\b`, "i"), (all, t: string) => {
    const win = readTerm(t, today);
    if (!win) return all;
    start = win.from;
    return " | ";
  });
  if (!start)
    w = w.replace(new RegExp(`\\b(${TERM})\\b`, "i"), (all, t: string) => {
      const win = readTerm(t, today);
      if (!win) return all;
      start = win.from;
      return " | ";
    });
  let from: string | undefined;
  // The place to leave from ends at the next separator, a colon included ("from Brasov: Lisbon 3 nights").
  w = w.replace(/\bfrom\s+([^,|;:]+?)(?=\s*(?:\||,|;|:|$))/i, (all, place: string) => {
    const p = cleanPlace(place);
    if (!placeLike(p)) return all;
    from = p;
    return " | ";
  });
  const stops: { place: string; nights: number }[] = [];
  let explicit = 0;
  let bare = 0;
  for (const seg of w.split(/\s*(?:,|;|:|\||\bthen\b|\band\b|\+|->|→)\s*/i)) {
    const s = seg.trim().replace(/^[-–.]+\s*/, "");
    if (!s) continue;
    let m = s.match(new RegExp(`^(.+?)\\s+(?:for\\s+)?(${NUM})\\s+(nights?|days?|weeks?)$`, "i"));
    let place = "";
    let n: number | null = null;
    let unit = "nights";
    let how: "unit" | "bare" | null = "unit";
    if (m) [place, n, unit] = [m[1], numberOf(m[2]), m[3]];
    else if ((m = s.match(new RegExp(`^(${NUM})\\s+(nights?|days?|weeks?)\\s+(?:in|at)\\s+(.+)$`, "i")))) [place, n, unit] = [m[3], numberOf(m[1]), m[2]];
    else if ((m = s.match(new RegExp(`^(${NUM})\\s+(?:in|at)\\s+(.+)$`, "i")))) [place, n] = [m[2], numberOf(m[1])];
    else if ((m = s.match(/^(.+?)\s+(\d{1,2})$/))) [place, n, how] = [m[1], Number(m[2]), "bare"];
    else [place, how] = [s, null];
    const name = cleanPlace(place);
    if (!placeLike(name)) continue;
    if (how === "unit") explicit++;
    else if (how === "bare") bare++;
    let nights = n ?? 2;
    if (/^week/i.test(unit)) nights *= 7;
    else if (/^day/i.test(unit)) nights = Math.max(1, nights - 1);
    stops.push({ place: name, nights: Math.min(30, Math.max(1, nights)) });
  }
  return { stops: stops.slice(0, 8), ...(start ? { start } : {}), ...(from ? { from } : {}), explicit, bare };
}

function routeLabel(c: { from?: string; to: string; depart?: string; nights?: number; oneWay?: boolean; win?: Win | null }, today: string): string {
  if (!c.to) return "Find the cheapest way from A to B";
  const when = c.win && !c.win.exact ? `, ${c.win.month ? "in " : ""}${winLabel(c.win, today)}` : c.depart ? `, ${dayLabel(c.depart, today)}` : "";
  return `${c.from ? `${c.from} to ${c.to}` : `To ${c.to}`}${when}${c.oneWay ? ", one way" : c.nights ? `, ${c.nights} night${c.nights === 1 ? "" : "s"}` : ""}`;
}
function eventsLabel(c: { words?: string[]; where?: string; win?: Win | null }, today: string): string {
  const words = c.words?.join(" ") ?? "";
  const what = words ? `${words[0].toUpperCase()}${words.slice(1)} events` : "Events worth the trip";
  return `${what}${c.where ? ` in ${c.where}` : ""}${c.win ? `, ${c.win.month ? "" : c.win.exact ? "from " : ""}${winLabel(c.win, today)}` : ""}`;
}

/** The ranked suggestions for one line. `today` is the traveller's calendar day, YYYY-MM-DD. */
export function parseCommand(text: string, today: string): Command[] {
  const day = ISO_RE.test(today) ? today : new Date().toISOString().slice(0, 10);
  const raw = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const ask: Command = { kind: "ask", text: raw, label: raw ? `Ask Atlas: ${raw.length > 60 ? raw.slice(0, 58) + "…" : raw}` : "Ask Atlas anything" };
  if (!raw) return [ask];
  const out: Command[] = [];
  const seen = new Set<string>();
  const push = (c: Command | null) => {
    if (!c) return;
    const k = `${c.kind}|${c.label}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  const finish = () => {
    push(ask);
    return out;
  };

  const r = readLine(raw, day);
  const lower = raw.toLowerCase();
  const restLower = r.rest.toLowerCase();
  const win = r.win;
  // A route needs one day: the day given; the first day of a stay written as a range (its
  // length is the nights); three days into a month or a week (searched three days either side).
  const departOf = (w: Win | null): { depart?: string; flex?: number; nights?: number } => {
    if (!w) return {};
    if (w.exact) return { depart: w.from };
    const span = daysBetween(w.from, w.to);
    if (!w.loose && span <= 60) return { depart: w.from, nights: span || undefined };
    let d = addDays(w.from, 3);
    if (d > w.to) d = w.from;
    return { depart: d, flex: 3 };
  };
  const route = (from: string | undefined, to: string): Command => {
    const d = departOf(win);
    const nights = r.oneWay ? undefined : (r.nights ?? r.nightsRange?.[0] ?? d.nights);
    const flex = r.flex ?? d.flex;
    return { kind: "route", ...(from ? { from } : {}), to, ...(d.depart ? { depart: d.depart } : {}), ...(nights ? { nights } : {}), ...(r.oneWay ? { oneWay: true } : {}), ...(flex != null ? { flex } : {}), label: routeLabel({ from, to, depart: d.depart, nights, oneWay: r.oneWay, win }, day) };
  };
  // Plurals become the word the purpose engine matches ("festivals" is festival); "fireworks"
  // and "northern lights" keep their s.
  const singular = (w: string) => (/^(?:carnivals|festivals|fests|fiestas|marathons|races|concerts|gigs|parades|lanterns|blossoms|christmas markets|sports)$/.test(w) ? w.slice(0, -1) : w).replace(/^fest$/, "festival").replace(/^(?:nye|hogmanay|new year'?s?(?: eve)?)$/, "new year");
  const eventWords = (s: string) => [...new Set([...s.toLowerCase().matchAll(EVENT_WORDS)].map((m) => singular(m[1])))].slice(0, 4);
  const events = (where?: string, words?: string[]): Command => {
    const ws = words?.length ? words : undefined;
    return { kind: "events", ...(win ? { from: win.from, to: win.exact ? addDays(win.from, 30) : win.to } : {}), ...(ws ? { words: ws } : {}), ...(where ? { where } : {}), label: eventsLabel({ words: ws, where, win: win && win.exact ? { ...win, to: addDays(win.from, 30) } : win }, day) };
  };
  const getaways = (where?: string): Command => {
    const range: [number, number] | null = r.nightsRange ?? (r.nights ? [r.nights, r.nights] : null);
    const w = win && win.exact ? { ...win, to: addDays(win.from, Math.max(7, range?.[1] ?? 7)), exact: false } : win;
    const label = `${where ? `${where}: the cheapest dates` : "Getaways"}${r.maxHours ? ` under ${r.maxHours} h` : ""}${r.maxPrice ? ` under €${r.maxPrice}` : ""}${w ? `, ${winLabel(w, day)}` : ""}${range ? `, ${range[0] === range[1] ? range[0] : `${range[0]} to ${range[1]}`} nights` : ""}`;
    return { kind: "getaways", ...(where ? { where } : {}), ...(w ? { from: w.from, to: w.to } : {}), ...(range ? { minNights: range[0], maxNights: range[1] } : {}), ...(r.maxHours ? { maxHours: r.maxHours } : {}), ...(r.maxPrice ? { maxPrice: r.maxPrice } : {}), label };
  };
  // The bare keys ("sea", "gulf") only count after /wild or /stay: "by the sea" is no region.
  const regionOf = (s: string, keys = false): [string, string] | null => {
    const hit = REGION_WORDS.find(([re]) => re.test(s));
    if (hit) return [hit[1], hit[2]];
    if (!keys) return null;
    const key = s.trim().split(/[\s|]+/).find((t) => Object.hasOwn(REGION_KEYS, t));
    return key ? [key, REGION_KEYS[key]] : null;
  };
  const countriesOf = (s: string): string[] =>
    s
      .split(/\s*(?:,|\||\band\b|&|\+|\/)\s*/i)
      .map(cleanPlace)
      .filter(placeLike)
      .slice(0, 8);
  /** "/wild sea 21", "/stay thailand 2": a bare number after a slash verb is the length. */
  const bareNumber = (rest: string): number | undefined => {
    const m = rest.match(/(?:^|[\s|])(\d{1,2})(?=[\s|]|$)/);
    return m ? Number(m[1]) : undefined;
  };
  const wild = (rest: string, keys = false): Command => {
    const reg = regionOf(rest.toLowerCase(), keys);
    const nights = r.nights ?? (r.nightsRange ? r.nightsRange[1] : undefined) ?? (keys ? bareNumber(rest) : undefined);
    if (keys) rest = rest.replace(/(?:^|[\s|])\d{1,2}(?=[\s|]|$)/, " ");
    const residue = reg ? "" : rest.replace(WILD_TRIGGER, " ").replace(/\b(?:a|an|the|in|through|across|around|of|wild|trip)\b/gi, " ");
    const countries = reg ? [] : countriesOf(residue);
    const where = reg ? reg[1] : countries.join(", ");
    return { kind: "wild", ...(reg ? { region: reg[0] } : {}), ...(countries.length ? { countries } : {}), ...(nights ? { nights } : {}), label: `A wild loop${where ? ` through ${where}` : ""}${nights ? `, ${nights} nights` : ""}` };
  };
  const longstay = (rest: string, keys = false): Command => {
    const reg = regionOf(rest.toLowerCase(), keys);
    const months = r.months ?? (r.nights && r.nights >= 28 ? Math.round(r.nights / 30) : undefined) ?? (keys ? bareNumber(rest) : undefined);
    if (keys) rest = rest.replace(/(?:^|[\s|])\d{1,2}(?=[\s|]|$)/, " ");
    const residue = reg ? "" : rest.replace(STAY_TRIGGER, " ").replace(/\b(?:a|an|the|in|stay|long|somewhere|month|months|for)\b/gi, " ");
    const countries = reg ? [] : countriesOf(residue);
    const where = reg ? reg[1] : countries.join(", ");
    return { kind: "longstay", ...(reg ? { region: reg[0] } : {}), ...(countries.length ? { countries } : {}), ...(months ? { months } : {}), label: `A long stay${where ? ` in ${where}` : ""}${months ? `, ${months} month${months === 1 ? "" : "s"}` : ""}` };
  };
  const itinerary = (): Command => {
    const st = readStops(raw, day);
    if (!st.stops.length) return { kind: "itinerary", label: "Make an itinerary of what is on screen" };
    const nights = st.stops.reduce((a, s) => a + s.nights, 0);
    return { kind: "itinerary", stops: st.stops, ...(st.start ? { start: st.start } : {}), ...(st.from ? { from: st.from } : {}), label: `Itinerary: ${st.stops.map((s) => `${s.place} ${s.nights} night${s.nights === 1 ? "" : "s"}`).join(", ")}${st.start ? `, from ${dayLabel(st.start, day)}` : ""}${st.from ? `, leaving ${st.from}` : ""}` };
  };
  const place = (name: string): Command => ({ kind: "place", name, label: `Open ${name}` });

  // Slash commands: the kind is decided, the rest are its arguments.
  const slash = raw.match(/^\/([a-z-]+)\s*(.*)$/i);
  if (slash) {
    const verb = slash[1].toLowerCase();
    const args = slash[2];
    const argRead = readLine(args, day);
    const argRest = argRead.rest;
    switch (verb) {
      case "route":
      case "r":
      case "go":
      case "way": {
        if (!args.trim()) return push({ kind: "route", to: "", label: routeLabel({ to: "" }, day) }), finish();
        const ends = splitRoute(argRest) ?? (placeLike(cleanPlace(argRest)) ? { to: cleanPlace(argRest) } : null);
        if (ends) push(route(ends.from, ends.to));
        return finish();
      }
      case "events":
      case "event":
      case "e":
      case "on": {
        const words = eventWords(args.toLowerCase());
        const where = cleanPlace(argRest.replace(EVENT_WORDS, " ").replace(EVENT_TRIGGER, " "));
        push(events(placeLike(where) ? where : undefined, words));
        return finish();
      }
      case "getaways":
      case "getaway":
      case "g":
      case "deals": {
        const where = cleanPlace(argRest.replace(GETAWAY_TRIGGER, " "));
        push(getaways(placeLike(where) ? where : undefined));
        return finish();
      }
      case "wild":
      case "w":
        push(wild(argRest, true));
        return finish();
      // "/loop" and "/walk" are the graph walk, unless a far region is named ("/loop sea 21" is still Wild).
      case "loop":
      case "walk":
        // A leading name is where the loop starts ("/loop Brasov 6 days"), as "loop from Brasov" would say it.
        push(regionOf(args.toLowerCase(), true) ? wild(argRest, true) : (readWalk(/^\s*(?:from\b|[^\p{L}])/iu.test(args) || !args.trim() ? `loop ${args}` : `loop from ${args}`, day) ?? wild(argRest, true)));
        return finish();
      case "stay":
      case "s":
      case "longstay":
      case "long":
        push(longstay(argRest, true));
        return finish();
      case "place":
      case "p":
      case "open": {
        const name = cleanPlace(args);
        if (placeLike(name)) push(place(name));
        return finish();
      }
      case "itinerary":
      case "itin":
      case "i":
      case "plan":
        push(itinerary());
        return finish();
      case "ask":
      case "a":
        return [{ ...ask, text: args.trim() || raw, label: `Ask Atlas: ${(args.trim() || raw).slice(0, 60)}` }];
      default:
        return finish();
    }
  }

  // Free text. The strong patterns first: they win even when the line is a question.
  if (ITIN_TRIGGER.test(lower)) {
    push(itinerary());
    return finish();
  }
  // A loop of hops ("loop from Brasov 20-30 Oct 6 days", "3 cities in 6 days", "Brasov to Warsaw then
  // train then home"): the graph walk, before the route and the list of stays, which would read only a piece of it.
  const walk = readWalk(raw, day);
  if (walk) {
    push(walk);
    return finish();
  }
  // A list of stays is an itinerary even without the word: "Lisbon 3 nights, Porto 2 nights",
  // "Lisbon 3 nights then Porto 2", or one stop with a bare number and a place to leave from
  // ("Porto 2 from Brasov on 1 Dec"), which nothing else reads.
  const st = readStops(raw, day);
  if ((st.explicit >= 1 && st.explicit + st.bare >= 2) || (st.stops.length === 1 && st.bare === 1 && st.from)) {
    push(itinerary());
    return finish();
  }
  const routeAsk = ROUTE_TRIGGER.test(lower);
  const ends = splitRoute(r.rest.replace(ROUTE_TRIGGER, " "));
  const eventAsk = EVENT_TRIGGER.test(restLower) || EVENT_TRIGGER.test(lower.replace(/\b(?:this|next) weekend\b/g, ""));
  const question = QUESTION.test(lower) || /\?\s*$/.test(raw);

  if (ends && (routeAsk || !question) && !eventAsk) {
    push(route(ends.from, ends.to));
    // A chain ("Rome to Paris to London"): the first hop is a route, the whole is a trip.
    if (ends.more?.length) {
      const stops = [ends.to, ...ends.more].map((p) => ({ place: p, nights: 2 }));
      push({ kind: "itinerary", stops, ...(win ? { start: win.from } : {}), ...(ends.from ? { from: ends.from } : {}), label: `Itinerary: ${stops.map((x) => `${x.place} 2 nights`).join(", ")}${win ? `, from ${dayLabel(win.from, day)}` : ""}${ends.from ? `, leaving ${ends.from}` : ""}` });
    }
    push(events(ends.to));
    push(place(ends.to));
    return finish();
  }
  if (eventAsk) {
    const words = eventWords(restLower);
    const where = cleanPlace(r.rest.replace(EVENT_WORDS, " ").replace(new RegExp(EVENT_TRIGGER.source, "gi"), " ").replace(/\b(?:what|is|are|on|there|any|good|cool|worth|flying|travelling|for|me|show|find|big|best|top|some)\b/gi, " "));
    const at = placeLike(where) ? where : undefined;
    push(events(at, words));
    if (at) push(route(undefined, at));
    else if (win) push(getaways());
    return finish();
  }
  if (STAY_TRIGGER.test(lower) || (r.months != null && r.months >= 1)) {
    push(longstay(r.rest));
    return finish();
  }
  if (WILD_TRIGGER.test(lower) || (regionOf(lower) && !question)) {
    push(wild(r.rest));
    if (regionOf(lower)) push(longstay(r.rest));
    return finish();
  }
  if (GETAWAY_TRIGGER.test(lower) && !(question && !/where (?:can|should) i go/.test(lower))) {
    const where = cleanPlace(r.rest.replace(new RegExp(GETAWAY_TRIGGER.source, "gi"), " ").replace(/\b(?:warm|sunny|cheap|cheapest|short|quick|me|show|find|some|good)\b/gi, " "));
    push(getaways(placeLike(where) ? where : undefined));
    if (win) push(events());
    return finish();
  }
  if (routeAsk) {
    const to = cleanPlace(r.rest.replace(ROUTE_TRIGGER, " ").replace(/\b(?:how|do|does|can|could|i|we|get|the|cheapest|fastest|best|way|there)\b/gi, " "));
    if (placeLike(to)) push(route(undefined, to));
    return finish();
  }
  if (question) return [ask];

  // A bare name, perhaps with a date or a stay: a place to go.
  const name = cleanPlace(r.rest);
  if (placeLike(name)) {
    // "one way" only means something for a route; a price cap is a getaways filter.
    if (r.oneWay) {
      push(route(undefined, name));
      push(place(name));
      push(events(name));
    } else if (win || r.nights || r.nightsRange || r.maxPrice) {
      push(getaways(name));
      push(route(undefined, name));
      push(events(name));
      push(place(name));
    } else {
      push(place(name));
      push(route(undefined, name));
      push(events(name));
    }
    return finish();
  }
  // Only a date or a stay: what is cheap then, and what is on.
  if (!name && (win || r.nights || r.nightsRange || r.maxHours || r.maxPrice)) {
    push(getaways());
    push(events());
    return finish();
  }
  return finish();
}
