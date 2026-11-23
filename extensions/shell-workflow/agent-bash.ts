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
import { sessionKeyOf } from "../../lib/core/session/identity.ts";
import type { SessionRef } from "../../lib/core/session/index.ts";
import { commandWrapFor } from "../../lib/internal/fence/fence-mac-command.ts";
import { placedCommand } from "../../lib/internal/priority/place.ts";
import type { Sandbox } from "../../lib/internal/sandbox/sandbox.ts";
import { isBash, teePersists } from "../../lib/internal/shell/kept.ts";
import {
	type SpawnerOptions,
	spawnedBy,
} from "../../lib/internal/shell/spawner.ts";
import { spawnerWanted } from "../../lib/internal/shell/spawner-variable.ts";
import {
	guardedEnvironment,
	SSH_GUARD_OFF,
	type SshGuard,
} from "../../lib/internal/shell/ssh-guard.ts";
import { COMMAND_VARIABLE, offCommandLine } from "./command-line.ts";
import { fromConversation, withoutInteraction } from "./environment.ts";
import { type Keeping, keepsOnDisk } from "./keeping.ts";
import { reapsWhatItLeft } from "./reap.ts";
import { timedKeeping } from "./timed-keeping.ts";

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

/**
 * pi's bash for the conversation `session`, built with its settings;
 * `spawner` stands in for parts of pi-spawner, for tests; `sshGuard` says
 * whether ssh to the person's own machines is refused, as each command
 * starts (lib/internal/shell/ssh-guard.ts).
 */
export function agentBash(
	cwd: string,
	settings: ShellSettings = {},
	sandbox: Sandbox = { kind: "none" },
	session?: SessionRef,
	spawner: SpawnerOptions = {},
	sshGuard: () => SshGuard = () => SSH_GUARD_OFF,
): AgentBash {
	// In a host running pi-spawner, the ones its pid started are other
	// conversations', so none is taken for one an earlier load left. A host
	// that turns it off, in the process's own environment, runs none for any.
	const sharing = hosted() && spawnerWanted(process.env);
	const loadSession =
		typeof session === "string"
			? session
			: session !== undefined
				? sessionKeyOf(session)
				: undefined;
	const spawning = spawnedBy(
		createLocalBashOperations(
			settings.shellPath ? { shellPath: settings.shellPath } : undefined,
		),
		{
			...(settings.shellPath ? { shellPath: settings.shellPath } : {}),
			...(sharing ? { reap: () => undefined } : {}),
			...spawner,
			// In a host, the load's own session, which the node is told its
			// spawners serve; last, so nothing else given names another. A pi
			// of its own needs none, its process being its session's alone; a
			// host refuses a load with no id before any command starts.
			...(sharing && loadSession ? { session: loadSession } : {}),
		},
	);
	// Each call keeps itself on disk where it can, so a move can hand it
	// on (keeping.ts), whether pi or pi-spawner starts it. A pi-spawner
	// from before kept commands kills them all when this pi goes, so
	// through it nothing is kept, and each call holds a move.
	const kept = keepsOnDisk(spawning, {
		can: async (env) => {
			if (!isBash(settings.shellPath)) return false;
			const [tee, spared] = await Promise.all([
				teePersists(env?.PATH),
				spawning.spares(),
			]);
			return tee && spared;
		},
	});
	// A time limit on work the queue holds starts when its turn does.
	// The command has left the command line by then, so it is read
	// where it travels. A stop, that limit's included, also kills what
	// left the shell's process group, as `timeout` does. Such a call is
	// still carried by the signal pi ran it under (timed-keeping.ts).
	const keeping = timedKeeping(kept, {
		around: reapsWhatItLeft,
		commandOf: (command, env) => env?.[COMMAND_VARIABLE] ?? command,
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
			const plain = withoutInteraction(fromConversation(context, session));
			const offered = {
				...plain,
				// A Mac's strict, laid per command, reads no stand-in in the
				// home either, so it goes without them as strict does.
				env: guardedEnvironment(
					plain.env,
					sshGuard(),
					sandbox.kind === "seatbelt" ? sandbox.asked : sandbox.kind,
				),
			};
			const wrap = commandWrapFor(sandbox, offered, homedir());
			return offCommandLine({
				...offered,
				command: placedCommand(offered.command, offered.cwd, wrap),
			});
		},
		// Asked for, each command starts in pi-spawner, so pi never forks
		// itself to start one (lib/internal/shell/spawner.ts).
		operations: keeping.operations,
	});
	return {
		...definition,
		retire: spawning.retire,
		carryOf: (signal) => keeping.carryOf(signal),
	};
}
