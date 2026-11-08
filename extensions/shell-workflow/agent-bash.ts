/**
 * pi's bash as the agent runs it: pi's own tool, built with the person's
 * shell settings, with this extension's changes to how a command starts.
 */

import { homedir } from "node:os";
import {
	type BashToolOptions,
	createBashToolDefinition,
	createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import { timedFromTurn } from "../../lib/internal/priority/clock.ts";
import { placedCommand } from "../../lib/internal/priority/place.ts";
import { type Sandbox, wrapFor } from "../../lib/internal/sandbox.ts";
import { COMMAND_VARIABLE, offCommandLine } from "./command-line.ts";
import { withoutInteraction } from "./environment.ts";
import { reapsWhatItLeft } from "./reap.ts";

/** The settings of pi's own that the agent's bash is built with too. */
export type ShellSettings = Pick<
	BashToolOptions,
	"commandPrefix" | "shellPath"
>;

export function agentBash(
	cwd: string,
	settings: ShellSettings = {},
	sandbox: Sandbox = { kind: "none" },
): ReturnType<typeof createBashToolDefinition> {
	return createBashToolDefinition(cwd, {
		...settings,
		// The shell moves itself into jobs before it runs anything, where
		// priority-workflow is placing what pi starts there. A session that
		// asked for the sandbox runs the command inside it once its turn
		// comes, with the environment it was offered. The command, that
		// move included, then leaves the shell's command line last, so
		// `pkill -f` cannot match the shell running it.
		spawnHook: (context) => {
			const offered = withoutInteraction(context);
			const wrap = wrapFor(sandbox, offered, homedir());
			return offCommandLine({
				...offered,
				command: placedCommand(offered.command, offered.cwd, wrap),
			});
		},
		// A time limit on work the queue holds starts when its turn does.
		// The command has left the command line by then, so it is read
		// where it travels. A stop, that limit's included, also kills what
		// left the shell's process group, as `timeout` does.
		operations: timedFromTurn(
			reapsWhatItLeft(
				createLocalBashOperations(
					settings.shellPath ? { shellPath: settings.shellPath } : undefined,
				),
			),
			{ commandOf: (command, env) => env?.[COMMAND_VARIABLE] ?? command },
		),
	});
}
