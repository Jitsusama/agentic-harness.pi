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
import { hosted } from "../../lib/core/session/host.ts";
import type { SessionRef } from "../../lib/core/session/index.ts";
import { timedFromTurn } from "../../lib/internal/priority/clock.ts";
import { placedCommand } from "../../lib/internal/priority/place.ts";
import { type Sandbox, wrapFor } from "../../lib/internal/sandbox.ts";
import { isBash, teePersists } from "../../lib/internal/shell/kept.ts";
import { spawnedBy } from "../../lib/internal/shell/spawner.ts";
import { SPAWNER_VARIABLE } from "../../lib/internal/shell/spawner-variable.ts";
import { COMMAND_VARIABLE, offCommandLine } from "./command-line.ts";
import { fromConversation, withoutInteraction } from "./environment.ts";
import { type Keeping, keepsOnDisk } from "./keeping.ts";
import { reapsWhatItLeft } from "./reap.ts";

/** The settings of pi's own that the agent's bash is built with too. */
export type ShellSettings = Pick<
	BashToolOptions,
	"commandPrefix" | "shellPath"
>;

/**
 * pi's bash, with a way to retire the pi-spawner behind it and to hand a
 * running call on.
 */
export type AgentBash = ReturnType<typeof createBashToolDefinition> & {
	/** Close its pi-spawner once the commands it runs have ended. */
	retire(): void;
	/** How the call run under a signal is handed on, if it can be. */
	carryOf: Keeping["carryOf"];
};

/** pi's bash for the conversation `session`, built with its settings. */
export function agentBash(
	cwd: string,
	settings: ShellSettings = {},
	sandbox: Sandbox = { kind: "none" },
	session?: SessionRef,
): AgentBash {
	// In a host running pi-spawner, the ones its pid started are other
	// conversations', so none is taken for one an earlier load left. A host
	// without it, by the process's own environment, runs none for any.
	const sharing = hosted() && process.env[SPAWNER_VARIABLE] === "on";
	// Each call pi starts itself keeps itself on disk where it can, so a
	// move can hand it on (keeping.ts). One pi-spawner starts is killed
	// when this pi goes, so it keeps nothing, and holds a move.
	const keeping = keepsOnDisk(
		createLocalBashOperations(
			settings.shellPath ? { shellPath: settings.shellPath } : undefined,
		),
		{
			can: async (env) =>
				isBash(settings.shellPath) && (await teePersists(env?.PATH)),
		},
	);
	const spawning = spawnedBy(keeping.operations, {
		...(settings.shellPath ? { shellPath: settings.shellPath } : {}),
		...(sharing ? { reap: () => undefined } : {}),
	});
	const definition = createBashToolDefinition(cwd, {
		...settings,
		// A command starts from its conversation's environment, which on a
		// host is not the process's (environment.ts).
		// The shell moves itself into jobs before it runs anything, where
		// priority-workflow is placing what pi starts there. A session that
		// asked for the sandbox runs the command inside it once its turn
		// comes, with the environment it was offered. The command, that
		// move included, then leaves the shell's command line last, so
		// `pkill -f` cannot match the shell running it.
		spawnHook: (context) => {
			const offered = withoutInteraction(fromConversation(context, session));
			const wrap = wrapFor(sandbox, offered, homedir());
			return offCommandLine({
				...offered,
				command: placedCommand(offered.command, offered.cwd, wrap),
			});
		},
		// A time limit on work the queue holds starts when its turn does.
		// The command has left the command line by then, so it is read
		// where it travels. A stop, that limit's included, also kills what
		// left the shell's process group, as `timeout` does. Asked for, each
		// command starts in pi-spawner, so pi never forks itself to start
		// one (lib/internal/shell/spawner.ts).
		operations: timedFromTurn(reapsWhatItLeft(spawning), {
			commandOf: (command, env) => env?.[COMMAND_VARIABLE] ?? command,
		}),
	});
	return {
		...definition,
		retire: spawning.retire,
		carryOf: (signal) => keeping.carryOf(signal),
	};
}
