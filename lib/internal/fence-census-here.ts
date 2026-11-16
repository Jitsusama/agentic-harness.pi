/**
 * `pi-fence census` on this machine: every realm's presences, its /proc
 * (or the one named), its clock and what earlier censuses saw, judged by
 * fence-census.ts, with what this one saw kept for the next.
 *
 * It lives apart from scripts/pi-fence.ts, which loads it only when the
 * census is asked for, because it reaches the mesh's presences and
 * through them packages, and core runs pi-fence's run path with no
 * node_modules (tests/scripts/pi-fence.test.ts runs it so).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPresences } from "../mesh/presence.ts";
import { censusHolds, censusText, fenceCensus } from "./fence-census.ts";
import { stageFolder } from "./fence-stage.ts";
import { everyRealmsDir, stateDir } from "./paths.ts";
import { keptFolder } from "./shell/kept.ts";
import { writeWhole } from "./write-whole.ts";

/** The status a census finding a session unfenced exits with. */
const UNFENCED = 1;

/** Clock ticks per second where getconf can't say, as Linux has it. */
const USUAL_TICKS = 100;

/** Only the person reads or writes what the census saw. */
const PRIVATE = 0o600;
const PRIVATE_FOLDER = 0o700;

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
function sightingsFile(): string {
	return join(stateDir("fence-census"), "proven.json");
}

/**
 * What an earlier census saw: session ids and when each was last seen
 * proven. A file that is missing or isn't that holds nothing, which can
 * only make a claimed session fail.
 */
function keptSightings(): Record<string, number> {
	let said: unknown;
	try {
		said = JSON.parse(readFileSync(sightingsFile(), "utf8"));
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
	// Whole or not at all, so a census cut short or two at once never
	// leave a half-written file that fails a claimed session for a day.
	writeWhole(sightingsFile(), `${JSON.stringify(sightings)}\n`, {
		mode: PRIVATE,
	});
}

/**
 * Run the census over the /proc named, this machine's unless asked
 * otherwise, write what it says, and answer the status pi-fence exits
 * with: 0 when there is at least one session and each was seen fenced,
 * 1 otherwise.
 */
export function censusHere(
	proc: string,
	write: (text: string) => void,
): number {
	const census = fenceCensus({
		proc,
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
	write(censusText(census));
	return censusHolds(census) ? 0 : UNFENCED;
}
