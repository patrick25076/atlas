// Where the deals ingest looks. City codes where a city has several airports (LON, PAR, MIL,
// ROM, STO), airport codes otherwise. Europe and the near-abroad first, a few long hauls for
// the surprising ones. Adding a destination is adding a code.
export const DESTINATIONS: string[] = [
  // Iberia and Italy
  "BCN", "MAD", "VLC", "SVQ", "AGP", "PMI", "IBZ", "LIS", "OPO", "FAO", "TFS", "LPA",
  "ROM", "MIL", "VCE", "NAP", "FLR", "BLQ", "CTA", "PMO", "BRI", "PSA", "TRN", "CAG",
  // France, Benelux, British Isles
  "PAR", "NCE", "LYS", "MRS", "BOD", "TLS", "LON", "EDI", "MAN", "DUB", "AMS", "BRU", "EIN",
  // Germany, Alps, Central Europe
  "BER", "MUC", "HAM", "FRA", "CGN", "DUS", "STR", "VIE", "SZG", "ZRH", "GVA", "BSL", "PRG", "BUD", "WAW", "KRK", "GDN", "BTS",
  // Nordics and Baltics
  "CPH", "STO", "OSL", "HEL", "TLL", "RIX", "VNO", "KEF",
  // Balkans and Greece
  "BEG", "SOF", "SKG", "ATH", "HER", "RHO", "CFU", "JTR", "JMK", "CHQ", "ZAG", "SPU", "DBV", "LJU", "TIA", "SKP", "TGD", "SJJ",
  // Turkey, Caucasus, Middle East, North Africa
  "IST", "ADB", "BJV", "DLM", "AYT", "TBS", "EVN", "GYD", "TLV", "AMM", "DXB", "AUH", "DOH", "MCT", "CAI", "HRG", "SSH", "RAK", "AGA", "TUN", "MLA", "LCA", "PFO",
  // Long haul
  "NYC", "BKK", "DEL", "BOM", "CMB", "MLE", "ZNZ", "NBO", "CPT", "KUL", "SIN", "TYO", "SEL",
];
