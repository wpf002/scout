import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Running local OSINT tools as subprocesses.
 *
 * theHarvester, Recon-ng, Sherlock and Maigret are programs, not services.
 * There is no endpoint to call and no key to hold — the dependency is a binary
 * on PATH, and the output arrives as stdout rather than JSON over HTTP. This
 * module is the seam for that, and it is deliberately narrow: callers name an
 * executable and pass an argument array, and nothing here ever builds a shell
 * command string.
 *
 * That last part is not stylistic. Every argument these tools receive contains
 * an investigator-supplied indicator — a domain, a username, an email. Through
 * a shell, a subject value containing `;` or a backtick is a command. `execFile`
 * with an argv array has no shell to interpret it, so a subject is a subject no
 * matter what it contains.
 */

/** Long enough for a real enumeration run, short enough to not hang a sweep. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Output past this is truncated rather than held in memory. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface CliRunOptions {
  /** Overrides the default timeout for tools that are legitimately slow. */
  timeoutMs?: number;
  /** Extra environment for the child. Never inherits secrets it has no use for. */
  env?: NodeJS.ProcessEnv;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  /** Null when the process was killed by a signal rather than exiting. */
  code: number | null;
  /** True when the run was cut short by the timeout. */
  timedOut: boolean;
}

/**
 * Thrown when a tool is not installed.
 *
 * Distinct from an execution failure on purpose: "not installed" is an inert
 * source, which is a normal reported state, while "installed and it failed" is
 * an error worth showing. Collapsing the two would make a machine that never
 * had the tool look identical to one where it broke.
 */
export class CliUnavailableError extends Error {
  readonly binary: string;

  constructor(binary: string) {
    super(`${binary} is not installed or not on PATH.`);
    this.name = "CliUnavailableError";
    this.binary = binary;
  }
}

/** Thrown when the tool ran and failed. */
export class CliFailedError extends Error {
  readonly code: number | null;
  readonly stderr: string;

  constructor(binary: string, code: number | null, stderr: string) {
    const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
    super(
      `${binary} exited with ${code ?? "a signal"}${detail ? `: ${detail}` : "."}`,
    );
    this.name = "CliFailedError";
    this.code = code;
    this.stderr = stderr;
  }
}

const availabilityCache = new Map<string, boolean>();

/**
 * Whether an executable can be found and run.
 *
 * Resolved against PATH by hand rather than by shelling out to `which`, which
 * would be one more process per source per sweep, and which does not exist
 * everywhere this might run.
 */
export async function isBinaryAvailable(binary: string): Promise<boolean> {
  const cached = availabilityCache.get(binary);
  if (cached !== undefined) return cached;

  const found = await resolveBinary(binary);
  availabilityCache.set(binary, found);
  return found;
}

/** Clears the availability cache. For tests, and after installing a tool. */
export function clearBinaryCache(): void {
  availabilityCache.clear();
}

async function resolveBinary(binary: string): Promise<boolean> {
  if (isAbsolute(binary)) return executable(binary);

  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    if (await executable(join(dir, binary))) return true;
  }
  return false;
}

async function executable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a local tool and returns its output.
 *
 * A non-zero exit is not automatically fatal — several of these tools exit
 * non-zero when they simply found nothing, and treating that as a failure
 * would turn "no results" into "this source is broken". Callers decide, via
 * the returned code, which of the two they are looking at.
 */
export async function runCli(
  binary: string,
  args: readonly string[],
  options: CliRunOptions = {},
): Promise<CliRunResult> {
  if (!(await isBinaryAvailable(binary))) {
    throw new CliUnavailableError(binary);
  }

  return new Promise<CliRunResult>((resolve, reject) => {
    const child = execFile(
      binary,
      [...args],
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        // No shell. See the note at the top of this file.
        shell: false,
        env: { ...process.env, ...options.env },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const timedOut =
          error !== null &&
          "killed" in error &&
          Boolean((error as { killed?: boolean }).killed);

        if (error !== null && !timedOut && typeof error.code === "string") {
          // ENOENT here means it vanished between the check and the spawn.
          if (error.code === "ENOENT") {
            reject(new CliUnavailableError(binary));
            return;
          }
          reject(error);
          return;
        }

        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          code:
            error !== null && typeof error.code === "number" ? error.code : 0,
          timedOut,
        });
      },
    );

    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new CliUnavailableError(binary));
        return;
      }
      reject(error);
    });
  });
}

/**
 * Parses tool output that is one JSON document.
 *
 * Several of these tools print progress banners to stdout before the JSON, so
 * the parse starts at the first brace rather than at byte zero.
 */
export function parseJsonOutput<T>(stdout: string): T | null {
  const start = stdout.search(/[[{]/);
  if (start === -1) return null;
  try {
    return JSON.parse(stdout.slice(start)) as T;
  } catch {
    return null;
  }
}

/** Splits output into non-empty trimmed lines, dropping ANSI colour codes. */
export function outputLines(stdout: string): string[] {
  return stdout
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
