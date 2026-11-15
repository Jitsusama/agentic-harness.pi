/**
 * Run Biome, and fail when it never ran. Biome's node wrapper spawns
 * the platform's binary and exits with its status, which is no status
 * at all when the binary is killed, so a kill reads as success. On a
 * Mac in Santa's lockdown the binary is killed at its start, and
 * `pnpm lint` passed there having checked nothing (OSPHT4 [f8cfd1a2],
 * 15 November). Lint runs on optimus, where Biome runs (P9R1KI
 * [dfff1286]), so a lint elsewhere says so rather than passing.
 *
 * Run it from the package root with Biome's own arguments:
 *
 *   node scripts/lint.ts check .
 *
 * Exits with Biome's status when Biome ran, and 1 with the reason when
 * it was killed or exited 0 without saying it checked anything.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

/** What a lint says when Biome didn't run. */
export const BIOME_DIDNT_RUN =
	"Biome didn't run (killed or blocked), so nothing was checked; lint runs on optimus.";

/** Biome's closing line whenever it checked any file, passing or not. */
const CHECKED = /Checked [\d,]+ files? in/;

/** Room for everything Biome says about a tree full of findings. */
const MOST_OUTPUT = 64 * 1024 * 1024;

/** What one run of Biome ended with. */
export interface BiomeRun {
	readonly status: number | null;
	readonly signal: string | null;
	readonly output: string;
}

/**
 * Why `run` checked nothing, or nothing when Biome ran and its own
 * status stands: killed, whatever it exited, or exiting 0 without its
 * closing line.
 */
export function biomeDidntRun(run: BiomeRun): string | undefined {
	if (run.signal !== null || run.status === null) return BIOME_DIDNT_RUN;
	if (run.status === 0 && !CHECKED.test(run.output)) return BIOME_DIDNT_RUN;
	return undefined;
}

/** Run Biome with this script's arguments, passing on what it says. */
function main(): void {
	const biome = createRequire(import.meta.url).resolve(
		"@biomejs/biome/bin/biome",
	);
	const ran = spawnSync(process.execPath, [biome, ...process.argv.slice(2)], {
		encoding: "utf8",
		maxBuffer: MOST_OUTPUT,
		stdio: ["inherit", "pipe", "pipe"],
	});
	process.stdout.write(ran.stdout ?? "");
	process.stderr.write(ran.stderr ?? "");
	if (ran.error) throw ran.error;
	const didnt = biomeDidntRun({
		status: ran.status,
		signal: ran.signal,
		output: `${ran.stdout ?? ""}${ran.stderr ?? ""}`,
	});
	if (didnt !== undefined) {
		process.stderr.write(`${didnt}\n`);
		process.exit(1);
	}
	process.exit(ran.status ?? 1);
}

if (import.meta.main) main();
