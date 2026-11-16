/**
 * pi-fence: runs one command in pi's fence for a caller outside pi, such
 * as the mycelium node starting an agent's `mycelium run` through its
 * declared `runs` prefix (lib/internal/fence-run.ts says the whole of it):
 *
 *   node scripts/pi-fence.ts --kind fence|strict [--folder DIR] -- PROGRAM [ARGUMENT...]
 *
 * The folder is the working directory unless named. The command's own
 * output and input pass straight through, and pi-fence exits with its
 * status, 128 and the signal's number when a signal ended it. It exits
 * 126, saying why on stderr, when it refuses to run, and 2 when it was
 * asked wrongly. `--help` says how to ask it, on stdout.
 */

import { spawnSync } from "node:child_process";
import { constants, homedir } from "node:os";
import {
	FENCE_RUN_HELP,
	fenceRunAsked,
	fenceRunText,
} from "../lib/internal/fence-run.ts";

/** The status a refusal exits with, as a shell's for a command it can't run. */
const REFUSED = 126;

/** The status a wrong asking exits with. */
const ASKED_WRONGLY = 2;

/** The status a signal's end gives, as a shell reports it. */
const SIGNALLED = 128;

const asked = fenceRunAsked(process.argv.slice(2), process.cwd());
if ("help" in asked) {
	process.stdout.write(FENCE_RUN_HELP);
	process.exit(0);
}
if ("wrong" in asked) {
	process.stderr.write(`pi-fence: ${asked.wrong}\n`);
	process.exit(ASKED_WRONGLY);
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
