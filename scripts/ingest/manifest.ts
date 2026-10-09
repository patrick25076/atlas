// Every ingest script records where its data came from, under which licence, and when.
// The globe shows this to the user: provenance is a feature, not a footnote.
import { mkdir, readFile, writeFile } from "node:fs/promises";

export type ManifestEntry = {
  source: string;
  url: string;
  licence: string;
  note?: string;
  fetchedAt: string;
  rows: number;
  file: string;
};

const MANIFEST = "public/data/manifest.json";

export async function recordManifest(key: string, entry: ManifestEntry) {
  await mkdir("public/data", { recursive: true });
  let manifest: Record<string, ManifestEntry> = {};
  try {
    manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  } catch {
    // first run
  }
  manifest[key] = entry;
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`${key}: ${entry.rows} rows → ${entry.file}`);
}
