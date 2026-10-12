// Famous places a traveller names that our place data does not hold as a town (Machu Picchu, the Uyuni salt flats,
// Angkor Wat), or holds as somewhere else (Bali is a town in India in the GeoNames file): each to the city with an
// airport (a code in cities.json) or the town (an overland link's, lib/overland.ts, or the towns file) a traveller
// stays in to see it.
// Read by route-finder's resolvePlace and the search's cityFor, so the chat, the Search tab and the walk agree.

/** Accents off, lower case, words only, a leading "the" dropped: "The Salar de Uyuni" and "salar de uyuni" are one key. */
const ACCENTS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");
export function landmarkKey(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(ACCENTS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

/** A landmark's base: a city with an airport, or an overland town by its name. */
export type Landmark = { code: string; town?: undefined } | { town: string; code?: undefined };

const TABLE: [string[], Landmark][] = [
  [["machu picchu", "machu pichu", "machupicchu", "inca trail"], { town: "Aguas Calientes" }],
  [["lake titicaca", "titicaca", "uros islands", "floating islands"], { town: "Puno" }],
  [["uyuni salt flats", "uyuni salt flat", "salar de uyuni", "salt flats", "salar"], { code: "UYU" }],
  [["rainbow mountain", "vinicunca", "sacred valley"], { code: "CUZ" }],
  [["atacama", "atacama desert", "valle de la luna"], { town: "San Pedro de Atacama" }],
  [["torres del paine"], { code: "PNT" }],
  [["patagonia", "perito moreno", "perito moreno glacier"], { code: "FTE" }],
  [["fitz roy"], { town: "El Chalten" }],
  [["iguazu falls", "iguacu falls", "iguassu falls", "iguazu waterfalls"], { code: "IGR" }],
  [["galapagos", "galapagos islands"], { code: "GPS" }],
  [["angkor wat", "angkor", "angkor temples"], { code: "SAI" }],
  [["ha long bay", "halong bay", "halong", "ha long"], { town: "Ha Long" }],
  [["bali"], { code: "DPS" }],
  [["komodo", "komodo island", "komodo national park"], { code: "LBJ" }],
  [["bagan"], { code: "NYU" }],
  [["inle lake", "inle"], { code: "HEH" }],
  [["phi phi", "phi phi islands", "ko phi phi"], { town: "Koh Phi Phi" }],
  [["taj mahal"], { code: "AGR" }],
  [["everest", "mount everest", "everest base camp"], { code: "KTM" }],
  [["kilimanjaro", "mount kilimanjaro", "mt kilimanjaro"], { code: "JRO" }],
  [["serengeti", "ngorongoro"], { code: "ARK" }],
  [["petra"], { town: "Petra" }],
  [["sahara", "sahara desert", "erg chebbi"], { town: "Merzouga" }],
  [["cappadocia", "goreme"], { code: "NAV" }],
  [["pamir", "pamir highway", "pamirs"], { code: "DYU" }],
  [["issyk kul", "lake issyk kul", "issyk-kul"], { town: "Cholpon-Ata" }],
  [["stepantsminda", "kazbek", "mount kazbek", "gergeti"], { town: "Kazbegi" }],
  [["mount fuji", "fuji", "mt fuji"], { town: "Hakone" }],
  [["santorini"], { code: "JTR" }],
  [["ella rock", "nine arches bridge"], { town: "Ella" }],
  [["cinque terre", "monterosso", "vernazza", "manarola", "riomaggiore"], { town: "La Spezia" }],
  [["amalfi coast", "amalfi", "positano", "sorrento"], { code: "NAP" }],
  [["lake bled", "bled"], { code: "LJU" }],
  [["plitvice", "plitvice lakes"], { code: "ZAG" }],
];
const BY_KEY = new Map<string, Landmark>();
for (const [names, l] of TABLE) for (const n of names) BY_KEY.set(landmarkKey(n), l);

/** The base of a landmark the words name, or null when they name none. */
export function landmarkOf(words: string): Landmark | null {
  return BY_KEY.get(landmarkKey(words)) ?? null;
}
