/**
 * Decide, headless, whether the launcher's fresh spawn goes to the host
 * quest-workflow's spawnHost names, before any window opens for it, so a
 * hosted spawn never flashes on the screen (OSPHT4 [b00fe454]). The
 * launcher runs it in the spawn's own folder and environment, through a
 * login shell, as it would the spawn's pi:
 *
 *   node --no-warnings scripts/spawn-decide.ts --session-id ID
 *     [--model PROVIDER/ID[:LEVEL]]
 *
 * It loads no pi. It prints `opening <host>` once it has sent the open,
 * and then the launcher waits for its answer rather than open a window
 * that would start a second session. It exits 0 (SPAWN_HOSTED) having
 * printed `hosted <host> <session>`: open nothing. It exits 3
 * (SPAWN_STAYS) having printed why, or nothing when spawnHost is off or
 * this isn't a spawn: open the window, with QUEST_WORKFLOW_SPAWN_STAYED
 * set to what it printed. Any other exit leaves the window's pi to decide.
 */

import { parseArgs } from "node:util";
import {
	decideSpawn,
	liveHandFacts,
} from "../extensions/quest-workflow/launched-spawn.ts";

const { values } = parseArgs({
	options: {
		"session-id": { type: "string" },
		model: { type: "string" },
	},
});

const sessionId = values["session-id"];
if (sessionId === undefined)
	throw new Error(
		"Usage: spawn-decide.ts --session-id ID [--model PROVIDER/ID[:LEVEL]]",
	);
process.exitCode = await decideSpawn(
	[
		"--session-id",
		sessionId,
		...(values.model ? ["--model", values.model] : []),
	],
	process.cwd(),
	liveHandFacts(process.env),
	(line) => process.stdout.write(`${line}\n`),
);
