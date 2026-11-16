/**
 * pi-fence: runs one command in pi's fence for a caller outside pi, such
 * as the mycelium node starting an agent's `mycelium run` through its
 * declared `runs` prefix (lib/internal/fence-run.ts says the whole of it):
 *
 *   node scripts/pi-fence.ts --kind fence|strict [--folder DIR] -- PROGRAM [ARGUMENT...]
 *   node scripts/pi-fence.ts census [--proc DIR]
 *
 * The folder is the working directory unless named. The command's own
 * output and input pass straight through, and pi-fence exits with its
 * status, 128 and the signal's number when a signal ended it. It exits
 * 126, saying why on stderr, when it refuses to run, and 2 when it was
 * asked wrongly. `--help` says how to ask it, on stdout.
 *
 * The census judges every live session on the machine, in every realm,
 * by its commands' processes (lib/internal/fence-census.ts), says so on
 * stdout, and exits 1 unless each was seen fenced: when one runs
 * unfenced, when a claimed one wasn't seen fenced in the last day, when
 * there is none, or when /proc can't be read. When it saw each session
 * fenced is kept in its state folder for the next census.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { constants, homedir } from "node:os";
import { join } from "node:path";
import {
	censusHolds,
	censusText,
	fenceCensus,
} from "../lib/internal/fence-census.ts";
import {
	FENCE_RUN_HELP,
	fenceRunAsked,
	fenceRunText,
} from "../lib/internal/fence-run.ts";
import { stageFolder } from "../lib/internal/fence-stage.ts";
import { everyRealmsDir, stateDir } from "../lib/internal/paths.ts";
import { keptFolder } from "../lib/internal/shell/kept.ts";
import { createPresences } from "../lib/mesh/presence.ts";

/** The status a refusal exits with, as a shell's for a command it can't run. */
const REFUSED = 126;

/** The status a wrong asking exits with. */
const ASKED_WRONGLY = 2;

/** The status a signal's end gives, as a shell reports it. */
const SIGNALLED = 128;

/** The status a census finding a session unfenced exits with. */
const UNFENCED = 1;

/** Clock ticks per second where getconf can't say, as Linux has it. */
const USUAL_TICKS = 100;

/** This machine's clock ticks per second, which /proc counts starts in. */
function ticksPerSecond(): number {
	try {
		const said = Number(
			execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }),
		);
		return Number.isSafeInteger(said) && said > 0 ? said : USUAL_TICKS;
	} catch {
		// No getconf on PATH: Linux's own count is right on every machine pi runs.
		return USUAL_TICKS;
	}
}

/** Where the census keeps when it last saw each session fenced. */
const SIGHTINGS = join(stateDir("fence-census"), "proven.json");

/** Only the person reads or writes what the census saw. */
const PRIVATE = 0o600;
const PRIVATE_FOLDER = 0o700;

/**
 * What an earlier census saw: session ids and when each was last seen
 * proven. A file that is missing or isn't that holds nothing, which can
 * only make a claimed session fail.
 */
function keptSightings(): Record<string, number> {
	let said: unknown;
	try {
		said = JSON.parse(readFileSync(SIGHTINGS, "utf8"));
	} catch {
		// No census ran here yet, or its file was spoiled: nothing was seen.
		return {};
	}
	if (typeof said !== "object" || said === null) return {};
	return Object.fromEntries(
		Object.entries(said).filter(
			(entry): entry is [string, number] => typeof entry[1] === "number",
		),
	);
}

/** Keep what this census saw for the next. */
function keepSightings(sightings: Readonly<Record<string, number>>): void {
	mkdirSync(stateDir("fence-census"), {
		recursive: true,
		mode: PRIVATE_FOLDER,
	});
	writeFileSync(SIGHTINGS, `${JSON.stringify(sightings)}\n`, {
		mode: PRIVATE,
	});
}

const asked = fenceRunAsked(process.argv.slice(2), process.cwd());
if ("help" in asked) {
	process.stdout.write(FENCE_RUN_HELP);
	process.exit(0);
}
if ("wrong" in asked) {
	process.stderr.write(`pi-fence: ${asked.wrong}\n`);
	process.exit(ASKED_WRONGLY);
}
if ("census" in asked) {
	const census = fenceCensus({
		proc: asked.census,
		presences: everyRealmsDir("state", "mesh-workflow").flatMap((mesh) =>
			createPresences(join(mesh, "presence")).all(),
		),
		stage: stageFolder(),
		ticksPerSecond: ticksPerSecond(),
		home: homedir(),
		...(process.env.XDG_RUNTIME_DIR
			? { runtimeDir: process.env.XDG_RUNTIME_DIR }
			: {}),
		kept: keptFolder(),
		sightings: keptSightings(),
		now: Date.now(),
	});
	if (census.read) keepSightings(census.sightings);
	process.stdout.write(censusText(census));
	process.exit(censusHolds(census) ? 0 : UNFENCED);
}
const made = fenceRunText(asked, { env: process.env, home: homedir() });
if ("refused" in made) {
	process.stderr.write(`pi-fence: ${made.refused}\n`);
	process.exit(REFUSED);
}
const ran = spawnSync("bash", ["-c", made.text], {
	cwd: made.folder,
	stdio: "inherit",
});
if (ran.error) {
	process.stderr.write(`pi-fence: bash didn't start: ${ran.error.message}\n`);
	process.exit(REFUSED);
}
const signal = ran.signal ? constants.signals[ran.signal] : undefined;
process.exit(
	signal === undefined ? (ran.status ?? REFUSED) : SIGNALLED + signal,
);
