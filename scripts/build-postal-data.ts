/**
 * Builds the postal-code lookup the registration form uses to fill in city
 * and state from a ZIP/postal code: app/data/postal/US.json and CA.json.
 *
 *   node scripts/build-postal-data.ts
 *
 * Source: GeoNames postal code files (https://www.geonames.org), licensed
 * CC BY 4.0. Re-run to refresh the data; the output is committed.
 *
 * Output shape (cities are "City|REGION", referenced by index):
 *   US: { cities, codes: { "44094": 12 } }
 *   CA: { cities, fsa: { "M5V": 3 }, codes: { "T0A0A1": 7 } }
 * Canadian codes are grouped by their first three characters (the FSA): the
 * FSA's most common city is stored once and only codes in a different city
 * are listed, which keeps 900k codes to about a megabyte.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const SOURCE = "https://download.geonames.org/export/zip";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../app/data/postal");

/** Reads one file from a zip archive (stored or deflated entries). */
function unzipEntry(archive: Buffer, name: string): string {
  // The end-of-central-directory record is in the last 64 KB + 22 bytes.
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("Not a zip file");
  const entries = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);

  for (let i = 0; i < entries; i++) {
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeader = archive.readUInt32LE(offset + 42);
    const entryName = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;

    const dataStart =
      localHeader +
      30 +
      archive.readUInt16LE(localHeader + 26) +
      archive.readUInt16LE(localHeader + 28);
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) return data.toString("utf8");
    if (method === 8) return inflateRawSync(data).toString("utf8");
    throw new Error(`Unsupported zip compression method ${method}`);
  }
  throw new Error(`${name} not found in archive`);
}

async function download(file: string, entry: string): Promise<string[][]> {
  const response = await fetch(`${SOURCE}/${file}`);
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  const text = unzipEntry(Buffer.from(await response.arrayBuffer()), entry);
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

/** Assigns each "City|REGION" an index, in first-seen order. */
function cityTable() {
  const cities: string[] = [];
  const index = new Map<string, number>();
  return {
    cities,
    id(city: string, region: string): number {
      const key = `${city.trim()}|${region.trim()}`;
      let id = index.get(key);
      if (id === undefined) {
        id = cities.push(key) - 1;
        index.set(key, id);
      }
      return id;
    },
  };
}

function write(country: string, data: unknown) {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${country}.json`);
  writeFileSync(path, JSON.stringify(data));
  console.log(`Wrote ${path}`);
}

async function buildUs() {
  // Columns: country, postal code, place, state name, state code, ...
  const rows = await download("US.zip", "US.txt");
  const table = cityTable();
  const codes: Record<string, number> = {};
  for (const [, zip, place, , state] of rows) {
    // Military (AA/AE/AP) and territory codes have no state in the form.
    if (!zip || !place || !/^[A-Z]{2}$/.test(state)) continue;
    codes[zip] ??= table.id(place, state);
  }
  write("US", { cities: table.cities, codes });
}

async function buildCa() {
  const rows = await download("CA_full.csv.zip", "CA_full.txt");
  const table = cityTable();
  const byFsa = new Map<string, Map<string, number>>();
  for (const [, postal, place, , province] of rows) {
    const code = postal?.replace(/\s+/g, "").toUpperCase();
    if (!code || code.length !== 6 || !place || !province) continue;
    let codes = byFsa.get(code.slice(0, 3));
    if (!codes) byFsa.set(code.slice(0, 3), (codes = new Map()));
    codes.set(code, table.id(place, province));
  }

  const fsa: Record<string, number> = {};
  const codes: Record<string, number> = {};
  for (const [prefix, entries] of byFsa) {
    const counts = new Map<number, number>();
    for (const id of entries.values()) counts.set(id, (counts.get(id) ?? 0) + 1);
    const [main] = [...counts].sort((a, b) => b[1] - a[1])[0];
    fsa[prefix] = main;
    for (const [code, id] of entries) {
      if (id !== main) codes[code] = id;
    }
  }
  write("CA", { cities: table.cities, fsa, codes });
}

await buildUs();
await buildCa();
