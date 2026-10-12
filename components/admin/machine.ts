// The engine room's map of the machine: every front door the traveller uses, every engine behind it, every source
// of data, and which uses which. Kept by hand next to the code it describes; the numbers are the constants in the
// files named (read them there when they move). Plain words, for the owner.

export type Node = {
  id: string;
  kind: "door" | "engine" | "data";
  name: string;
  /** One line under the name. */
  line: string;
  /** What it does, step by step, in plain words. */
  how?: string[];
  /** The algorithm, when there is one. */
  algo?: string;
  /** What it minimises, as a formula in words. */
  cost?: string;
  /** Live Kiwi searches one use costs. */
  spends?: string;
  file?: string;
  /** Ids this one uses (door → engine, engine → engine or data). */
  uses?: string[];
};

export const MACHINE: Node[] = [
  // ---------------- the front doors ----------------
  {
    id: "search",
    kind: "door",
    name: "Search tab",
    line: "From, To, When, Nights, Advanced: one list of trips",
    how: [
      "Reads the bar into one SearchQuery (lib/trip-result.ts).",
      "Asks the nightly price graph first: no live search, under a second.",
      "Then runs the live engines that fit the question, inside a budget of live searches (25 by default, 0 means stored prices only).",
      "Every answer becomes the same TripResult: door-to-airport legs added, badges, the Been check, duplicates by cities and days dropped (the cheaper stays).",
      "Ranked by money door to door (tickets plus ground) plus hours at the trip style's rate (0 at Cheapest); the chips filter after, instantly.",
    ],
    file: "lib/search.ts",
    uses: ["answers", "flightgraph", "pairs", "routefinder", "walk", "wildwalk", "scan", "longstay", "group"],
  },
  {
    id: "trippage",
    kind: "door",
    name: "Trip page",
    line: "One card opened: tickets, ways home, hotels, sights, food",
    how: ["Shows the legs the engine built, one booking link per ticket.", "Ways home: a live calendar of the days around the end, direct first, to every home airport.", "Hotels (LiteAPI), sights (Wikivoyage), events (city feeds), food (Foursquare) load as you scroll."],
    file: "components/TripPage.tsx",
    uses: ["wayhome", "kiwi", "liteapi", "places"],
  },
  {
    id: "plan",
    kind: "door",
    name: "Make it a plan",
    line: "Day by day itinerary from a trip",
    how: ["Takes the trip's stops, nights and legs as fixed.", "A language model writes each day (morning, afternoon, night, food) with a few web searches per place.", "Prices of travel come from the trip, never from the model."],
    algo: "No graph. A language model with research, checked against the trip's own legs.",
    file: "lib/itinerary-server.ts",
    uses: ["llm", "tavily", "places"],
  },
  {
    id: "ask",
    kind: "door",
    name: "Ask (the chat)",
    line: "A language model that calls the same engines as tools",
    how: ["The model reads your words and the trip style, assumes what is unsaid, and calls tools.", "Its tools are the engines below (search, walk_trips, wild_trip, cheapest_way, way_home, events, hotels, sights, make_itinerary and more).", "It may ask one question at most, through a widget."],
    algo: "No graph of its own: it picks which engine to run.",
    spends: "up to 120 a turn across its tools",
    file: "app/api/chat/route.ts, lib/agent-tools.ts",
    uses: ["llm", "search", "walk", "wildwalk", "routefinder", "wayhome", "pairs", "scan"],
  },

  // ---------------- the engines ----------------
  {
    id: "flightgraph",
    kind: "engine",
    name: "Price graph trips",
    line: "Cheapest trips over last night's flights: a Dijkstra on euros",
    how: [
      "Nodes are (city, day). Edges are flights from the nightly graph and the fare memory, trains and coaches from the ground graph (priced at 0.10 euro a km), and stays of 2 to 3 nights.",
      "Starts at your door, goes to every home airport, searches outward cheapest first.",
      "Keeps up to 6 different city sequences per node, so three London airports cannot crowd out Paris.",
      "Stops when no open label can beat the 20th best closed trip; answers the best distinct city sequences.",
    ],
    algo: "Label-setting search (multi-criteria Dijkstra), exact on what the graph holds.",
    cost: "euros + hours × rate (0 at Cheapest) + 12 euro per change of plane",
    spends: "0",
    file: "lib/flight-graph.ts (cheapestTripsIn, everywhereIn)",
    uses: ["nightly", "memory", "ground"],
  },
  {
    id: "walk",
    kind: "engine",
    name: "Graph walk (loops)",
    line: "Skyscanner Explore by hand: anywhere from here, then anywhere from there",
    how: [
      "From home: one search to anywhere over the departure window (the fare memory first).",
      "From each stop: the fare memory, else one live search to anywhere (or the region's hubs) over the days the stop can leave on, plus every train or coach within 5.5 h.",
      "Every way out gets a cost; the cheapest per city is kept; the best 3 states per depth go on (the beam).",
      "A stop that has had its nights tries home: the memory, else one search to all home airports.",
      "Closed loops are ranked by total cost.",
    ],
    algo: "Best-first beam search over edges found as it goes (lazy edges).",
    cost: "price + hours × 2 euro + 12 euro per change of plane − the place's worth (saturating, never more than 45 euro at Cheapest, so taste breaks ties but never pays double); a layover of 18 to 60 h is a free night, worth a little less than a stop",
    spends: "about 2 a stop plus the way in and home (12 to 40); 0 walks the memory only",
    file: "lib/graph-walk.ts",
    uses: ["kiwi", "memory", "ground", "boards", "fame"],
  },
  {
    id: "wildwalk",
    kind: "engine",
    name: "Wild loop",
    line: "The graph walk aimed at a region's biggest airports",
    how: ["The same walk, but each hop searches the biggest hubs of the region's countries not seen yet, instead of anywhere.", "Two cities a country at most, so one country's cheap trains cannot take every slot."],
    algo: "Best-first beam search (the graph walk, targeted).",
    cost: "as the graph walk",
    spends: "about 2 a stop plus 4",
    file: "lib/wild-walk.ts → lib/graph-walk.ts",
    uses: ["walk"],
  },
  {
    id: "pairs",
    kind: "engine",
    name: "Paired one-ways",
    line: "Out and home as two tickets, paired by dates",
    how: ["One-way out to anywhere or a country, one-way home from the places found, to any home airport within 6 h of you.", "Pairs them by nights; a second city by land (up to about 4 h) or by air becomes a two-city trip."],
    algo: "Search, then join on dates. No graph.",
    cost: "tickets + ground + hours × 2 euro",
    spends: "about 16 to 31 (aimed at the countries the graph found cheapest)",
    file: "lib/pairs.ts",
    uses: ["kiwi", "memory", "ground"],
  },
  {
    id: "routefinder",
    kind: "engine",
    name: "Cheapest way A to B",
    line: "Every way between two places, door to door",
    how: ["Nearby airports at both ends, a train to a bigger airport, two tickets through a hub, open-jaw, or the ground graph alone when close.", "Each way priced door to door; the cheapest and the fastest badged."],
    algo: "Candidates by rule, the ground part by Dijkstra on minutes.",
    cost: "tickets + ground + hours × 2 euro",
    spends: "up to 12 (24 when asked to search harder)",
    file: "lib/route-finder.ts",
    uses: ["kiwi", "memory", "ground"],
  },
  {
    id: "wayhome",
    kind: "engine",
    name: "Ways home",
    line: "A week of flights home from a city, direct first",
    how: ["One search from the city to all home airports over the days around the trip's end.", "Per day the cheapest and the cheapest direct, with the ground leg to your door."],
    spends: "1 to 4",
    file: "lib/way-home.ts",
    uses: ["kiwi", "memory"],
  },
  {
    id: "scan",
    kind: "engine",
    name: "Price calendar",
    line: "Month by month for one destination",
    spends: "about 6",
    file: "lib/scan.ts",
    uses: ["kiwi", "memory"],
  },
  { id: "longstay", kind: "engine", name: "Long stay", line: "1 to 6 months in cheap bases, rent and living included", spends: "about 16", file: "lib/longstay.ts", uses: ["kiwi", "costs"] },
  { id: "group", kind: "engine", name: "Group", line: "Where friends from different cities meet", spends: "about 20", file: "lib/group.ts", uses: ["kiwi"] },

  // ---------------- the data ----------------
  { id: "nightly", kind: "data", name: "Nightly flight graph", line: "164 airports × 14 three-day buckets, the 15 cheapest each: about 19,000 flights, six weeks ahead", file: "scripts/ingest/flight-edges.ts → Blob graph/flights/" },
  { id: "answers", kind: "data", name: "Shared answers", line: "An hour, for every visitor and server: the same search, walk or way home is read back, not run again", file: "lib/shared-cache.ts (Postgres answers)" },
  { id: "memory", kind: "data", name: "Fare memory", line: "Every live search writes its fares to Postgres; engines read the last day first", file: "lib/db.ts (fares)" },
  { id: "kiwi", kind: "data", name: "Kiwi live search", line: "One search: from, to (anywhere, a country, a list of airports), a date range; 15 itineraries back", file: "lib/kiwi.ts (6 at a time, 24 h memo, 1,500 a day)" },
  { id: "ground", kind: "data", name: "Ground graph", line: "23,000 stations from public timetables (GTFS); Dijkstra on minutes", algo: "Dijkstra", file: "lib/ground.ts" },
  { id: "boards", kind: "data", name: "Price boards", line: "Tonight's cheapest returns from about 150 airports", file: "scripts/ingest/boards.ts → Blob boards/" },
  { id: "fame", kind: "data", name: "Fame and listings", line: "Wikipedia views and Wikivoyage listings: what a place is worth a stop", file: "public/data/fame.json" },
  { id: "costs", kind: "data", name: "Living costs", line: "World Bank price levels per country", file: "public/data/costs.json" },
  { id: "liteapi", kind: "data", name: "Hotels", line: "LiteAPI rates for the nights", file: "lib/liteapi.ts" },
  { id: "places", kind: "data", name: "Sights, food, events", line: "Wikivoyage, Foursquare, city event feeds", file: "lib/sights.ts, lib/foursquare.ts, lib/events" },
  { id: "llm", kind: "data", name: "Language model", line: "GPT-6 Astra on Bedrock: the chat, the plans, the judge", file: "app/api/chat, lib/plan.ts, lib/judge.ts" },
  { id: "tavily", kind: "data", name: "Web search", line: "Tavily, a few queries a place for plans and the chat", file: "lib/tavily.ts" },
];

/** The table the owner asked for: which feature uses which graph. */
export const GRAPH_TABLE: { feature: string; priceGraph: string; groundGraph: string; live: string; llm: string; algorithm: string }[] = [
  { feature: "Search: everywhere, windows, two cities, loops", priceGraph: "yes, first", groundGraph: "yes", live: "after, within 25", llm: "no", algorithm: "Dijkstra on euros over (city, day)" },
  { feature: "Search: a place on exact dates", priceGraph: "yes", groundGraph: "yes", live: "route finder, pairs", llm: "no", algorithm: "rules + Dijkstra on minutes for ground" },
  { feature: "Search Advanced: Wild loop", priceGraph: "yes, first", groundGraph: "yes", live: "the walk, targeted", llm: "no", algorithm: "beam search over lazy edges" },
  { feature: "Search Advanced: Long stay, Group", priceGraph: "no", groundGraph: "no", live: "yes", llm: "no", algorithm: "search and score" },
  { feature: "Ask: walk_trips, wild_trip", priceGraph: "no (the fare memory)", groundGraph: "yes", live: "yes, 12 to 40", llm: "picks the tool", algorithm: "beam search over lazy edges" },
  { feature: "Ask: cheapest_way", priceGraph: "no", groundGraph: "yes", live: "up to 12", llm: "picks the tool", algorithm: "rules + Dijkstra on minutes" },
  { feature: "Trip page: Ways home", priceGraph: "no", groundGraph: "for the leg home", live: "1 to 4", llm: "no", algorithm: "one search, per-day minimum" },
  { feature: "Make it a plan", priceGraph: "no", groundGraph: "no", live: "no", llm: "yes", algorithm: "a model writes the days" },
];
