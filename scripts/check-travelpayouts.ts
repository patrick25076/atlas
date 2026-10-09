// Smoke test for SETUP.md §2: does the token work, and what does the API return for one origin?
// Usage: pnpm check:tp [IATA]
import { hasToken, inboundFares, latestFares } from "../lib/travelpayouts";

try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local yet
}

if (!hasToken()) {
  console.error("TRAVELPAYOUTS_TOKEN is not set. See SETUP.md §2.");
  process.exit(1);
}

const origin = (process.argv[2] ?? "OTP").toUpperCase();
const fares = await latestFares(origin);
console.log(`${fares.length} destinations with a cached fare from ${origin}`);
for (const f of fares.slice(0, 8)) {
  console.log(`  ${f.src} → ${f.dst}  €${f.price}  ${f.departureAt}  ${f.airline || "?"}  ${f.transfers ? `${f.transfers} stop` : "direct"}`);
}
if (fares[0]) console.log(`  example link: ${fares[0].url.replace(/marker=[^&]+/, "marker=***")}`);
const back = await inboundFares(origin);
console.log(`${back.length} origins with a cached fare into ${origin}`);
for (const f of back.slice(0, 5)) console.log(`  ${f.src} → ${f.dst}  €${f.price}  ${f.departureAt}`);
