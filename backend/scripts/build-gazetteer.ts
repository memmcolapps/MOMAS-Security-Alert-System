/**
 * Builds the dense reverse-geocoding gazetteer from the GeoNames Nigeria dump.
 *
 * The curated list in src/geocoder/index.ts stays where it is: it exists to
 * spot place names inside incident text, where 177 well-known names give
 * precision and 61,000 would match "Aba" or "Ola" inside half the sentences in
 * the corpus. This dataset answers the opposite question - coordinates to a
 * label - and there density is the whole point. Lagos carried two entries in
 * the curated list, so every position in the state came back "Near Ikeja".
 *
 * Data: GeoNames (https://www.geonames.org), CC BY 4.0.
 *
 *   bun run scripts/build-gazetteer.ts <NG.txt> <admin1CodesASCII.txt> <admin2Codes.txt>
 *
 * Downloads: http://download.geonames.org/export/dump/
 *
 * Known gap: GeoNames carries no prominence signal for Nigerian urban
 * districts - Wuse and Gidan Nbora are both plain PPL with population 0, and
 * Victoria Island is absent entirely - so a coordinate in one of those can be
 * labelled from an obscure neighbour instead. OSM maps those districts well and
 * would fill it, but its Nigerian `place` coverage is uneven (Lagos and Kano
 * are rich, Benin City has none) and most are polygons, which Overpass will not
 * export at country scale without timing out. Filling this needs a planet-file
 * extract processed offline rather than a live query.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [dumpPath, admin1Path, admin2Path] = process.argv.slice(2);
if (!dumpPath || !admin1Path || !admin2Path) {
  console.error("Usage: bun run scripts/build-gazetteer.ts <NG.txt> <admin1CodesASCII.txt> <admin2Codes.txt>");
  process.exit(1);
}

const readLines = async (path: string) =>
  (await Bun.file(path).text()).split("\n").filter(Boolean);

// "NG.05" -> "Lagos". GeoNames spells some of these "Rivers State" and others
// bare; the trailing word goes so the whole set reads consistently and matches
// how the rest of MOMAS names states.
const states = new Map<string, string>();
for (const line of await readLines(admin1Path)) {
  const [code, name] = line.split("\t");
  if (!code?.startsWith("NG.")) continue;
  states.set(code.slice(3), name.replace(/\s+State$/i, "").trim());
}

// "NG.05.25013" -> "Kosofe"
const lgas = new Map<string, string>();
for (const line of await readLines(admin2Path)) {
  const [code, name] = line.split("\t");
  if (!code?.startsWith("NG.")) continue;
  lgas.set(code.slice(3), name.trim());
}

type Entry = [name: string, lat: number, lon: number, state: string, lga: string, rank: number];

// Bigger places win ties, so a coordinate between a hamlet and a town that are
// equally close is described by the one a responder has heard of. Administrative
// seats are ranked up for the same reason.
function rankOf(featureCode: string, population: number) {
  if (featureCode === "PPLC") return 6;
  if (featureCode === "PPLA") return 5;
  if (featureCode === "PPLA2") return 4;
  if (population > 100000) return 3;
  if (population > 10000) return 2;
  if (population > 0) return 1;
  return 0;
}

const entries: Entry[] = [];
const seen = new Set<string>();

for (const line of await readLines(dumpPath)) {
  const f = line.split("\t");
  if (f[6] !== "P") continue;
  const name = (f[1] || "").trim();
  const lat = Number(f[4]);
  const lon = Number(f[5]);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

  const state = states.get(f[10]) || "";
  const lga = f[11] ? lgas.get(`${f[10]}.${f[11]}`) || "" : "";
  if (!state) continue;

  // GeoNames carries the same settlement several times at near-identical
  // coordinates. Rounding to ~100 m collapses those without merging genuine
  // neighbours.
  const key = `${name.toLowerCase()}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
  if (seen.has(key)) continue;
  seen.add(key);

  entries.push([name, Number(lat.toFixed(4)), Number(lon.toFixed(4)), state, lga, rankOf(f[7], Number(f[14]) || 0)]);
}

entries.sort((a, b) => a[1] - b[1] || a[2] - b[2]);

const out = resolve(import.meta.dir, "../src/geocoder/nigeria-places.json");
writeFileSync(out, JSON.stringify({ attribution: "GeoNames, CC BY 4.0", entries }));

const byState = new Map<string, number>();
for (const entry of entries) byState.set(entry[3], (byState.get(entry[3]) || 0) + 1);
console.log(`Wrote ${entries.length} places to ${out}`);
console.log(`States: ${byState.size} · Lagos: ${byState.get("Lagos") || 0} · FCT: ${byState.get("FCT") || 0}`);
console.log(`With an LGA: ${entries.filter((entry) => entry[4]).length}`);
