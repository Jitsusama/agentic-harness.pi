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
 * Or, for the launcher's own Start a Session and Orchestrate, in the
 * quest's folder with QUEST_WORKFLOW_AUTOLOAD_ID set, whether the start
 * goes to the attended host quest-workflow's startHost names, opened
 * idle on its quest and told nothing, for the launcher to open its
 * viewer at once (OSPHT4 [27ca7454]):
 *
 *   node --no-warnings scripts/spawn-decide.ts --start [--orchestrate]
 *     [--model PROVIDER/ID[:LEVEL]]
 *
 * It loads no pi. It prints `opening <host>` once it has sent the open,
 * and then the launcher waits for its answer rather than open a window
 * that would start a second session. It exits 0 (SPAWN_HOSTED) having
 * printed `hosted <host> <session>`: open nothing but, for a start, the
 * session's viewer. It exits 3 (SPAWN_STAYS) having printed why, or
 * nothing when its setting is off or this isn't a spawn or a start: open
 * the window, a spawn's with QUEST_WORKFLOW_SPAWN_STAYED set to what it
 * printed. Any other exit leaves the window's pi to decide.
 */

import { parseArgs } from "node:util";
import {
	decideSpawn,
	decideStart,
	launchedStart,
	liveHandFacts,
	liveStartFacts,
	SPAWN_STAYS,
} from "../extensions/quest-workflow/launched-spawn.ts";

const USAGE =
	"Usage: spawn-decide.ts (--session-id ID | --start [--orchestrate]) [--model PROVIDER/ID[:LEVEL]]";

const { values } = parseArgs({
	options: {
		"session-id": { type: "string" },
		start: { type: "boolean" },
		orchestrate: { type: "boolean" },
		model: { type: "string" },
	},
});

const say = (line: string) => process.stdout.write(`${line}\n`);
const model = values.model ? ["--model", values.model] : [];
const sessionId = values["session-id"];

if (values.start) {
	const start = launchedStart(
		["--start", ...(values.orchestrate ? ["--orchestrate"] : []), ...model],
		process.env,
		process.cwd(),
	);
	process.exitCode = start
		? await decideStart(start, liveStartFacts(process.env), say)
		: SPAWN_STAYS;
} else if (sessionId === undefined) {
	throw new Error(USAGE);
} else {
	process.exitCode = await decideSpawn(
		["--session-id", sessionId, ...model],
		process.cwd(),
		liveHandFacts(process.env),
		say,
	);
}
