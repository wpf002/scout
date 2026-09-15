/**
 * Imports a voter registration file the operator obtained themselves.
 *
 * Scout does not fetch these. State files are requester-gated — several demand
 * a notarized affidavit or state residency — and most carry use restrictions,
 * with Texas making commercial use a Class A misdemeanor and Washington a
 * felony. The lawful path is that the operator requests the file under their
 * own name and permitted purpose; this loads what they were given.
 *
 * Every state publishes a different layout, so columns are matched by header
 * name rather than position, with per-state overrides for the files that have
 * no usable header. A column this cannot identify is skipped rather than
 * guessed into the wrong field.
 *
 * Usage:
 *   pnpm voters:import <file> --state=PA
 *   pnpm voters:import <file> --state=FL --replace
 */
import { createReadStream, existsSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

import { prisma } from "../client.js";

const BATCH = 2_000;

/**
 * Header patterns per field, tried in order. Deliberately loose: "DOB",
 * "BIRTH_DATE" and "Date of Birth" are the same column in three states.
 */
const PATTERNS: Record<string, RegExp[]> = {
  voterId: [/^(state.?)?voter.?(id|no|number|reg|reg.?num)$/i, /^registration.?(id|number)?$/i, /^ncid$/i, /^id.?number$/i],
  lastName: [/^(voter.?)?last.?name$/i, /^surname$/i, /^name.?last$/i],
  firstName: [/^(voter.?)?first.?name$/i, /^given.?name$/i, /^name.?first$/i],
  middleName: [/^(voter.?)?middle.?(name|initial)$/i, /^name.?middle$/i],
  suffix: [/^(name.?)?suffix$/i],
  birthDate: [/^(date.?of.?birth|birth.?date|dob)$/i],
  birthYear: [/^(birth.?year|year.?of.?birth|yob)$/i],
  street: [/^(residential|residence|res).?(address|street).*$/i, /^street.?(address|name)?$/i, /^address.?1?$/i],
  city: [/^(residential|residence|res).?city$/i, /^city$/i],
  zip: [/^(residential|residence|res).?zip.*$/i, /^zip.?(code)?5?$/i, /^postal.?code$/i],
  county: [/^county(.?name|.?code)?$/i],
  party: [/^part(y|isan).?(code|affiliation|name)?$/i, /^political.?party$/i],
  status: [/^(voter.?)?status$/i, /^registration.?status$/i],
  phone: [/^(full.?|home.?|daytime.?|residence.?)?(tele)?phone.*$/i],
};

/**
 * States whose published file has no header row. The order is the state's own
 * documented layout; anything not needed is left unnamed.
 *
 * Only add a state here after reading its published file layout — a wrong
 * order here silently files birth dates as zip codes.
 */
const HEADERLESS: Record<string, string[]> = {
  // Pennsylvania Full Voter Export, per the state's published layout.
  PA: [
    "voterId", "", "lastName", "firstName", "middleName", "suffix",
    "birthDate", "", "", "party", "", "", "", "", "", "", "", "", "",
  ],
};

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
}

/** Tab, pipe or comma — whichever the header line actually uses. */
export function sniffDelimiter(line: string): string {
  const counts: Array<[string, number]> = [
    ["\t", (line.match(/\t/g) ?? []).length],
    ["|", (line.match(/\|/g) ?? []).length],
    [",", (line.match(/,/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]?.[1] === 0 ? "," : (counts[0]?.[0] ?? ",");
}

/**
 * Government files decorate column names with a type suffix — county_desc,
 * party_cd, name_suffix_lbl, voter_reg_num. They carry no meaning for us and
 * they are what stopped North Carolina's header from matching at all, so they
 * come off before the patterns run.
 */
export function canonicalHeader(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/_(desc|descr|description|cd|code|lbl|label|num|number|abbrv|abbr|txt|ind)$/i, "");
}

/** Which of our fields each column holds, or "" for columns we ignore. */
export function mapHeader(header: string[]): string[] {
  return header.map((raw) => {
    const name = canonicalHeader(raw);
    for (const [field, patterns] of Object.entries(PATTERNS)) {
      if (patterns.some((p) => p.test(name))) return field;
    }
    return "";
  });
}

/** A header row is one whose cells look like names rather than data. */
export function looksLikeHeader(cells: string[]): boolean {
  const named = cells.filter((c) => /[A-Za-z]{3,}/.test(c)).length;
  const numeric = cells.filter((c) => /^\d+$/.test(c.trim())).length;
  return named >= Math.max(2, cells.length / 3) && numeric <= cells.length / 4;
}

/** The date formats these files actually use. */
export function parseDate(raw: string): Date | null {
  const v = raw.trim();
  if (v === "") return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m !== null) return safeDate(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m !== null) return safeDate(+m[3]!, +m[1]!, +m[2]!);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m !== null) return safeDate(+m[1]!, +m[2]!, +m[3]!);
  return null;
}

function safeDate(y: number, mo: number, d: number): Date | null {
  if (y < 1890 || y > 2030 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return Number.isNaN(date.getTime()) ? null : date;
}

function clean(v: string | undefined): string | null {
  const t = v?.trim().replace(/^["']|["']$/g, "") ?? "";
  return t === "" ? null : t;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  const state = arg("state")?.toUpperCase() ?? null;
  const replace = process.argv.includes("--replace");

  if (file === undefined || file.startsWith("--") || state === null) {
    process.stderr.write("Usage: pnpm voters:import <file> --state=XX [--replace]\n");
    process.exit(1);
  }
  if (!existsSync(file)) {
    process.stderr.write(`No such file: ${file}\n`);
    process.exit(1);
  }
  if (!/^[A-Z]{2}$/.test(state)) {
    process.stderr.write("--state must be a two-letter state code.\n");
    process.exit(1);
  }

  const source = basename(file);

  let columns: string[] | null = null;
  let delimiter = ",";
  let batch: Array<Record<string, unknown>> = [];
  let written = 0;
  let skipped = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await prisma.voterRecord.createMany({ data: batch as never });
    written += batch.length;
    batch = [];
    process.stdout.write(`  ${written}\r`);
  };

  if (replace) {
    const removed = await prisma.voterRecord.deleteMany({ where: { state } });
    process.stdout.write(`Removed ${removed.count} existing ${state} rows.\n`);
  }

  // Opened only now, and never before an await.
  //
  // createInterface starts the stream flowing immediately, so a reader created
  // above the deleteMany emitted lines while that await was outstanding and
  // before the for-await consumer attached — they were dropped on the floor.
  // The count lost varied with how long the delete took, which is why the
  // header went missing on the 4 GB file and survived on a small sample, and
  // why each run reported a different row as the header.
  const reader = createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    if (line.trim() === "") continue;

    if (columns === null) {
      delimiter = sniffDelimiter(line);
      const cells = line.split(delimiter);
      const headerless = HEADERLESS[state];

      if (headerless !== undefined && !looksLikeHeader(cells)) {
        columns = headerless;
        // No header line to consume — this row is data, so fall through.
      } else {
        columns = mapHeader(cells);
        const found = columns.filter((c) => c !== "").length;
        if (!columns.includes("lastName")) {
          process.stderr.write(
            `Could not find a surname column in the header.\n` +
              `Headers seen: ${cells.slice(0, 12).join(", ")}\n` +
              `Add a layout for ${state} to HEADERLESS, or check the file.\n`,
          );
          process.exit(1);
        }
        process.stdout.write(`Matched ${found} columns, delimiter ${JSON.stringify(delimiter)}.\n`);
        continue;
      }
    }

    const cells = line.split(delimiter);
    const row: Record<string, string> = {};
    columns.forEach((field, i) => {
      if (field !== "") row[field] = cells[i] ?? "";
    });

    const lastName = clean(row["lastName"]);
    if (lastName === null) {
      skipped += 1;
      continue;
    }

    const birthDate = row["birthDate"] === undefined ? null : parseDate(row["birthDate"]);
    const yearRaw = Number.parseInt(clean(row["birthYear"]) ?? "", 10);

    batch.push({
      state,
      voterId: clean(row["voterId"]),
      lastName: lastName.toUpperCase(),
      firstName: clean(row["firstName"])?.toUpperCase() ?? null,
      middleName: clean(row["middleName"])?.toUpperCase() ?? null,
      suffix: clean(row["suffix"]),
      birthDate,
      // A full date implies the year; keep it either way so a year-only state
      // and a full-date state answer the same query.
      birthYear: birthDate !== null ? birthDate.getUTCFullYear()
        : Number.isInteger(yearRaw) && yearRaw > 1890 ? yearRaw : null,
      street: clean(row["street"]),
      city: clean(row["city"])?.toUpperCase() ?? null,
      zip: clean(row["zip"])?.slice(0, 10) ?? null,
      county: clean(row["county"]),
      party: clean(row["party"]),
      status: clean(row["status"]),
      phone: clean(row["phone"]),
      sourceFile: source,
    });

    if (batch.length >= BATCH) await flush();
  }
  await flush();

  const withDob = await prisma.voterRecord.count({
    where: { state, birthDate: { not: null } },
  });
  process.stdout.write(
    `\nLoaded ${written} ${state} records (${withDob} with a full date of birth).` +
      `${skipped > 0 ? ` Skipped ${skipped} with no surname.` : ""}\n`,
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
