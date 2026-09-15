/**
 * Loads the FAA civil aircraft registry.
 *
 * The FAA publishes the whole registry as a zip and offers no per-tail API, so
 * answering "who is registered to this aircraft" means holding the file. 316k
 * rows, refreshed weekly upstream; run this whenever that matters.
 *
 * Two things the download needs. registry.faa.gov sits behind Akamai, which
 * refuses a default curl or undici user-agent with 403 — a browser UA is the
 * difference between a 73 MB archive and a 407-byte denial. And MASTER.txt is
 * comma-separated with every field space-padded to a fixed width, so every
 * value has to be trimmed or the join keys carry trailing spaces and never
 * match anything.
 *
 * Usage: pnpm faa:sync
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { prisma } from "../client.js";

const run = promisify(execFile);

const ARCHIVE = "https://registry.faa.gov/database/ReleasableAircraft.zip";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** Rows per insert. Large enough to be fast, small enough not to blow the parameter limit. */
const BATCH = 2_000;

/** The FAA's registrant type codes. */
const OWNER_TYPE: Record<string, string> = {
  "1": "Individual",
  "2": "Partnership",
  "3": "Corporation",
  "4": "Co-Owned",
  "5": "Government",
  "7": "LLC",
  "8": "Non-Citizen Corporation",
  "9": "Non-Citizen Co-Owned",
};

/** "20230122" as the FAA writes it. */
function faaDate(raw: string): Date | null {
  if (!/^\d{8}$/.test(raw)) return null;
  const date = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** Manufacturer and model, keyed by the MFR MDL CODE that MASTER references. */
function readAircraftRef(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split("\n");
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const code = clean(cols[0]);
    const mfr = clean(cols[1]);
    const model = clean(cols[2]);
    if (code === null) continue;
    out.set(code, [mfr, model].filter((x) => x !== null).join(" ").trim());
  }
  return out;
}

async function main(): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "faa-"));
  try {
    process.stdout.write("Downloading the FAA registry… ");
    const response = await fetch(ARCHIVE, {
      headers: { "user-agent": BROWSER_UA, accept: "*/*" },
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error(`FAA responded ${response.status}`);
    if (response.body === null) throw new Error("FAA returned an empty body.");

    const zipPath = join(work, "registry.zip");
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(zipPath));
    process.stdout.write("done\n");

    // unzip rather than a library: the archive is 73 MB and this avoids
    // holding a second copy of it in the heap.
    await run("unzip", ["-o", "-q", zipPath, "MASTER.txt", "ACFTREF.txt"], {
      cwd: work,
      maxBuffer: 1024 * 1024,
    });

    const models = readAircraftRef(await readFile(join(work, "ACFTREF.txt"), "utf8"));
    const master = await readFile(join(work, "MASTER.txt"), "utf8");
    const lines = master.split("\n");

    process.stdout.write(`Loading ${lines.length - 1} rows…\n`);
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AircraftRegistration"');

    let batch: Array<Record<string, unknown>> = [];
    let written = 0;

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      await prisma.aircraftRegistration.createMany({
        data: batch as never,
        skipDuplicates: true,
      });
      written += batch.length;
      batch = [];
      process.stdout.write(`  ${written}\r`);
    };

    for (const line of lines.slice(1)) {
      const cols = line.split(",");
      // A short row is a truncated trailing line, not a record. The hex Mode S
      // column is index 33, so anything shorter cannot carry the ADS-B join.
      if (cols.length < 34) continue;

      const nNumber = clean(cols[0]);
      const ownerName = clean(cols[6]);
      if (nNumber === null || ownerName === null) continue;

      const year = Number.parseInt(clean(cols[4]) ?? "", 10);
      // Column 22 is "MODE S CODE" and it is OCTAL — 50004305, not A00C05.
      // ADS-B broadcasts the hex form, so joining on the octal column would
      // have matched nothing and looked like an empty registry. Column 34 is
      // the hex the FAA publishes alongside it.
      const modeS = clean(cols[33]);

      batch.push({
        nNumber,
        serialNumber: clean(cols[1]),
        // Stored uppercase so the ADS-B join never depends on case.
        modeSHex: modeS === null ? null : modeS.toUpperCase(),
        yearMfr: Number.isInteger(year) && year > 1900 ? year : null,
        ownerName,
        ownerType: OWNER_TYPE[clean(cols[5]) ?? ""] ?? null,
        street: clean(cols[7]),
        city: clean(cols[9]),
        state: clean(cols[10]),
        zip: clean(cols[11]),
        county: clean(cols[13]),
        country: clean(cols[14]),
        aircraft: models.get(clean(cols[2]) ?? "") ?? null,
        statusCode: clean(cols[20]),
        certIssued: faaDate(clean(cols[16]) ?? ""),
        lastAction: faaDate(clean(cols[15]) ?? ""),
      });

      if (batch.length >= BATCH) await flush();
    }
    await flush();

    process.stdout.write(`\nLoaded ${written} aircraft.\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
