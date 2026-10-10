// Events worth flying for: the ones people plan a year around. Dates are the usual month and
// days; the exact edition is checked live (web search) before a trip is priced. City codes
// are the places on the globe. Curated by hand, 2026 edition; the model and the web fill in
// the rest when asked for something not here.
export type PurposeEvent = { name: string; city: string; code: string; country: string; month: number; day?: number; endDay?: number; kind: "festival" | "sport" | "culture" | "season" | "music" | "food"; note: string };

export const PURPOSE_EVENTS: PurposeEvent[] = [
  { name: "Carnival of Venice", city: "Venice", code: "VCE", country: "IT", month: 2, day: 7, endDay: 17, kind: "festival", note: "masks on the lagoon; peaks the final weekend" },
  { name: "Rio Carnival", city: "Rio de Janeiro", code: "RIO", country: "BR", month: 2, day: 13, endDay: 18, kind: "festival", note: "the Sambadrome parades" },
  { name: "Holi", city: "Jaipur", code: "JAI", country: "IN", month: 3, day: 3, kind: "festival", note: "the colour festival; Mathura and Vrindavan nearby" },
  { name: "Las Fallas", city: "Valencia", code: "VLC", country: "ES", month: 3, day: 15, endDay: 19, kind: "festival", note: "giant sculptures burned on the 19th" },
  { name: "Cherry blossom", city: "Tokyo", code: "TYO", country: "JP", month: 3, day: 25, endDay: 10, kind: "season", note: "late March to early April; Kyoto a week later" },
  { name: "Songkran", city: "Chiang Mai", code: "CNX", country: "TH", month: 4, day: 13, endDay: 15, kind: "festival", note: "the water festival" },
  { name: "King's Day", city: "Amsterdam", code: "AMS", country: "NL", month: 4, day: 27, kind: "festival", note: "orange, canals, street markets" },
  { name: "Primavera Sound", city: "Barcelona", code: "BCN", country: "ES", month: 6, day: 4, endDay: 6, kind: "music", note: "" },
  { name: "Midsummer", city: "Stockholm", code: "STO", country: "SE", month: 6, day: 19, endDay: 20, kind: "festival", note: "the archipelago, flower crowns" },
  { name: "Glastonbury", city: "Bristol", code: "BRS", country: "GB", month: 6, day: 24, endDay: 28, kind: "music", note: "tickets sell out a year ahead" },
  { name: "Roskilde", city: "Copenhagen", code: "CPH", country: "DK", month: 6, day: 27, endDay: 4, kind: "music", note: "" },
  { name: "Running of the Bulls", city: "Pamplona", code: "PNA", country: "ES", month: 7, day: 6, endDay: 14, kind: "festival", note: "San Fermín" },
  { name: "Gion Matsuri", city: "Osaka", code: "OSA", country: "JP", month: 7, day: 17, kind: "festival", note: "Kyoto's float procession" },
  { name: "Tomorrowland", city: "Brussels", code: "BRU", country: "BE", month: 7, day: 17, endDay: 26, kind: "music", note: "Boom, near Antwerp" },
  { name: "Sziget", city: "Budapest", code: "BUD", country: "HU", month: 8, day: 5, endDay: 10, kind: "music", note: "the island festival" },
  { name: "Edinburgh Fringe", city: "Edinburgh", code: "EDI", country: "GB", month: 8, day: 1, endDay: 25, kind: "culture", note: "the world's biggest arts festival; book rooms early" },
  { name: "La Tomatina", city: "Valencia", code: "VLC", country: "ES", month: 8, day: 26, kind: "festival", note: "Buñol, 40 km away" },
  { name: "Notting Hill Carnival", city: "London", code: "LON", country: "GB", month: 8, day: 30, endDay: 31, kind: "festival", note: "" },
  { name: "Oktoberfest", city: "Munich", code: "MUC", country: "DE", month: 9, day: 19, endDay: 4, kind: "festival", note: "mid September to early October" },
  { name: "Berlin Marathon", city: "Berlin", code: "BER", country: "DE", month: 9, day: 27, kind: "sport", note: "the flat, fast one; ballot" },
  { name: "Mid-Autumn lanterns", city: "Hong Kong", code: "HKG", country: "HK", month: 9, day: 25, kind: "festival", note: "Victoria Park lanterns, fire dragon dance" },
  { name: "Albuquerque Balloon Fiesta", city: "Albuquerque", code: "ABQ", country: "US", month: 10, day: 3, endDay: 11, kind: "festival", note: "hundreds of balloons at dawn" },
  { name: "Chicago Marathon", city: "Chicago", code: "CHI", country: "US", month: 10, day: 11, kind: "sport", note: "" },
  { name: "Diwali", city: "New Delhi", code: "DEL", country: "IN", month: 11, day: 8, kind: "festival", note: "lamps and fireworks; Jaipur and Varanasi too" },
  { name: "Day of the Dead", city: "Mexico City", code: "MEX", country: "MX", month: 11, day: 1, endDay: 2, kind: "festival", note: "the parade and the Oaxaca cemeteries" },
  { name: "Samhuinn Fire Festival", city: "Edinburgh", code: "EDI", country: "GB", month: 10, day: 31, kind: "festival", note: "Halloween on Calton Hill; Scotland's own" },
  { name: "Loy Krathong and Yi Peng", city: "Chiang Mai", code: "CNX", country: "TH", month: 11, day: 24, endDay: 25, kind: "festival", note: "thousands of lanterns released" },
  { name: "New York Marathon", city: "New York", code: "NYC", country: "US", month: 11, day: 1, kind: "sport", note: "" },
  { name: "Christmas markets", city: "Vienna", code: "VIE", country: "AT", month: 12, day: 1, endDay: 23, kind: "season", note: "Vienna, Prague, Nuremberg, Strasbourg" },
  { name: "Northern lights season", city: "Tromso", code: "TOS", country: "NO", month: 12, day: 1, endDay: 28, kind: "season", note: "December to March, Tromsø and Lofoten" },
  { name: "Harbin Ice Festival", city: "Harbin", code: "HRB", country: "CN", month: 1, day: 5, endDay: 28, kind: "festival", note: "ice palaces at minus 25" },
  { name: "Up Helly Aa", city: "Edinburgh", code: "EDI", country: "GB", month: 1, day: 27, kind: "festival", note: "Shetland's Viking fire festival; fly on to Sumburgh" },
  { name: "Tet", city: "Ho Chi Minh City", code: "SGN", country: "VN", month: 2, day: 17, kind: "festival", note: "Vietnamese new year; many shops close" },
  { name: "Sakura in Kyoto", city: "Osaka", code: "OSA", country: "JP", month: 4, day: 1, endDay: 10, kind: "season", note: "Philosopher's Path, Arashiyama" },
  { name: "Monaco Grand Prix", city: "Nice", code: "NCE", country: "FR", month: 5, day: 24, kind: "sport", note: "" },
  { name: "Cannes Film Festival", city: "Nice", code: "NCE", country: "FR", month: 5, day: 12, endDay: 23, kind: "culture", note: "" },
  { name: "Inti Raymi", city: "Cusco", code: "CUZ", country: "PE", month: 6, day: 24, kind: "festival", note: "the Inca sun festival at Sacsayhuamán" },
  { name: "Lantern Festival", city: "Taipei", code: "TPE", country: "TW", month: 2, day: 12, kind: "festival", note: "Pingxi sky lanterns" },
  { name: "Burning Man", city: "Reno", code: "RNO", country: "US", month: 8, day: 30, endDay: 7, kind: "festival", note: "Black Rock Desert; tickets by lottery" },
  { name: "Exit Festival", city: "Belgrade", code: "BEG", country: "RS", month: 7, day: 9, endDay: 12, kind: "music", note: "Novi Sad fortress" },
  { name: "Untold", city: "Cluj-Napoca", code: "CLJ", country: "RO", month: 8, day: 6, endDay: 9, kind: "music", note: "" },
  { name: "Vivid Sydney", city: "Sydney", code: "SYD", country: "AU", month: 5, day: 22, endDay: 13, kind: "culture", note: "light festival, late May to mid June" },
  { name: "Mardi Gras", city: "New Orleans", code: "MSY", country: "US", month: 2, day: 17, kind: "festival", note: "the weeks before Fat Tuesday" },
  { name: "Marrakech Popular Arts Festival", city: "Marrakech", code: "RAK", country: "MA", month: 7, day: 1, endDay: 5, kind: "culture", note: "verify dates" },
  { name: "Cape Town Jazz Festival", city: "Cape Town", code: "CPT", country: "ZA", month: 3, day: 27, endDay: 28, kind: "music", note: "" },
  { name: "Naadam", city: "Ulaanbaatar", code: "ULN", country: "MN", month: 7, day: 11, endDay: 13, kind: "festival", note: "wrestling, horse racing, archery on the steppe" },
  { name: "Gerewol", city: "Niamey", code: "NIM", country: "NE", month: 9, day: 20, kind: "festival", note: "Wodaabe courtship festival; check security" },
  { name: "Wimbledon", city: "London", code: "LON", country: "GB", month: 6, day: 29, endDay: 12, kind: "sport", note: "the queue for day tickets" },
  { name: "Tour de France finale", city: "Paris", code: "PAR", country: "FR", month: 7, day: 26, kind: "sport", note: "Champs-Élysées" },
  { name: "Fête des Lumières", city: "Lyon", code: "LYS", country: "FR", month: 12, day: 5, endDay: 8, kind: "culture", note: "the city lit up" },
];

/** Events falling in a window, with their likely dates for that year (a span that crosses a month end runs into the next month). */
export function eventsInWindow(from: string, to: string): (PurposeEvent & { start: string; end: string })[] {
  const out: (PurposeEvent & { start: string; end: string })[] = [];
  const y0 = Number(from.slice(0, 4));
  for (const e of PURPOSE_EVENTS) {
    for (const y of [y0, y0 + 1]) {
      const start = new Date(Date.UTC(y, e.month - 1, e.day ?? 1));
      let end = new Date(Date.UTC(y, e.month - 1, e.endDay ?? e.day ?? 28));
      if (end < start) end = new Date(Date.UTC(y, e.month, e.endDay ?? 1));
      const s = start.toISOString().slice(0, 10);
      const en = end.toISOString().slice(0, 10);
      if (en >= from && s <= to) out.push({ ...e, start: s, end: en });
    }
  }
  return out;
}
