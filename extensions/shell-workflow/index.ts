/**
 * Shell Workflow Extension
 *
 * Registers `bash` as pi's own bash tool, built with the same settings,
 * with five changes. The agent's commands run with no interactive editor
 * or pager, since nobody is at the keyboard to leave one. Each command is
 * kept off its shell's command line, so `pkill -f` with a pattern from it
 * kills what it names rather than the shell running it. A time limit on
 * work the machine's queue holds starts when its turn does, not while it
 * waits (lib/internal/priority/clock.ts). And a command
 * still running after a minute is handed to job-workflow rather than
 * holding the session silently: the call returns saying so, and the job
 * says how the command ended. A model expecting a long run passes
 * `background`; a codemode script's calls are never handed off, nor
 * are a print or JSON run's, which exits as its prompts end. A
 * session started with `PI_SANDBOX=strict` runs each command under
 * Landlock, with no credentials and no sockets but name lookups and
 * Nix's untrusted door (sandbox.ts). Each command keeps its output and
 * end on disk while it runs, so a session moving to a host can hand a
 * running one on rather than wait for it (keeping.ts).
 *
 * Everything else, the output truncation, the saved full output, the
 * rendering and the structured result codemode reads, is pi's.
 */

import {
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { sessionCwd, sessionKeyOf } from "../../lib/core/session/index.ts";
import { jobsBroker } from "../../lib/internal/fence.ts";
import { askTheCloudAhead, sandboxFor } from "../../lib/internal/sandbox.ts";
import { sweepKept } from "../../lib/internal/shell/kept.ts";
import {
	endsWithItsPrompts,
	HAND_OFF_MS,
	spoken,
} from "../../lib/jobs/hand-off.ts";
import { type AgentBash, agentBash, type ShellSettings } from "./agent-bash.ts";
import { runOrHandOff } from "./hand-off.ts";

/** The settings pi builds its own bash with, as this project sees them. */
function shellSettings(ctx: ExtensionContext): ShellSettings {
	try {
		const settings = SettingsManager.create(sessionCwd(ctx), getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		});
		const commandPrefix = settings.getShellCommandPrefix();
		const shellPath = settings.getShellPath();
		return {
			...(commandPrefix ? { commandPrefix } : {}),
			...(shellPath ? { shellPath } : {}),
		};
	} catch {
		// Settings pi could not read are settings pi ran without too; its
		// own bash falls back to the defaults the same way.
		return {};
	}
}

/** Whether this machine runs the jobs broker a fenced command may ask. */
const hasJobsBroker = (): boolean =>
	jobsBroker(process.env.XDG_RUNTIME_DIR) !== undefined;

/** The folder pi's bash is built with when only its shape is wanted. */
const SHAPE_ONLY = "";

export default function shellWorkflow(pi: ExtensionAPI) {
	// The shape pi's bash is drawn and described with. Its folder is never
	// used: execution is per session, at the folder its conversation stands
	// in, and pi's description names none.
	const shape = createBashToolDefinition(SHAPE_ONLY);
	// Asked for when the session starts, by its environment (sandbox.ts).
	const sandbox = sandboxFor();
	let bash: AgentBash | undefined;
	// A bash given up closes its pi-spawner once its commands end, so a
	// reload or a new session leaves none running behind it.
	const retireBash = () => {
		bash?.retire();
		bash = undefined;
	};

	const bashFor = (ctx: ExtensionContext): AgentBash => {
		bash ??= agentBash(
			sessionCwd(ctx),
			shellSettings(ctx),
			sandbox,
			sessionKeyOf(ctx),
		);
		return bash;
	};

	pi.on("session_start", async (_event, ctx) => {
		retireBash();
		bashFor(ctx);
		askTheCloudAhead(sandbox);
		// What a call kept and nobody took up, a week on (kept.ts).
		sweepKept();
	});
	pi.on("session_shutdown", retireBash);

	pi.registerTool({
		...shape,
		description: `${shape.description} A command still running after ${spoken(HAND_OFF_MS)} moves to the background, and its result arrives later as a message of its own, so the session never stops hearing the person or other sessions for longer than that.`,
		promptGuidelines: [
			...(shape.promptGuidelines ?? []),
			"Let a command's output through: do not pipe it into tail or head to keep it short, since bash already keeps the end and saves the full output to a file, and a pipe hides all progress until the command ends.",
			"Do not sleep in bash to wait for something. Pass background: true for a command expected to run long, or use a tool's own watch, and carry on; the result arrives as its own message. A call sent with background: true may sleep between its checks; never pause by reading /dev/zero or /dev/urandom, or with yes, which keeps a core busy the whole time.",
			...(sandbox.kind === "strict"
				? [
						"Commands run in a strict sandbox, since this session reads what strangers wrote: no credentials, no SSH or signing agent, no session or system bus, writes only to the working folder and the sandbox's own TMPDIR and cache (not /tmp or ~/.cache), and Nix as an untrusted user. gcloud, where the machine gives a token, acts as the agents' own cloud account in its one project, never the person's login. A refusal there is the sandbox, not a fault: do the work another way, or say what needs the person.",
					]
				: []),
			...(sandbox.kind === "fence"
				? [
						"Commands run in the agent fence: their own processes only, no display, compositor, session or system bus, sound, keyring, password, clipboard or SSH agent, settings and startup files (~/.config, shell rc files, ~/.ssh, ~/.pi/agent) read-only, and Nix as an untrusted user. The work, the network and the environment are as they were. A `nix-offload there ...` call on its own, with nothing chained on, runs outside the fence. A refusal there is the fence, not a fault: do the work another way (commit and push with the work tool), or say what needs the person.",
						...(hasJobsBroker()
							? [
									"Inside the agent fence the cgroup tree is read-only and systemctl and systemd-run can't reach the account's systemd. For how a unit stands, run `jobs-broker status UNIT...` rather than `systemctl --user status`; for a command that wants a scope of its own, run `jobs-broker run -- COMMAND` rather than `systemd-run --user --scope`.",
								]
							: []),
					]
				: []),
			// Only where commands are placed in the jobs cgroup: elsewhere
			// nice still ranks a command against what the person uses.
			...(process.env.JOBS_CGROUP
				? [
						"Do not add nice or ionice to a command. Every command already runs in a cgroup below everything the person uses, where nice only ranks it against other agents' work: a niced VM test loses to every build beside it and times out, and a niced nix build slows only its own evaluation, since the Nix daemon does the building.",
						"Builds, test suites, evaluations of a flake's checks or a whole machine, and searches of a whole World checkout wait their turn here while the machine is busy. Build or evaluate a repository's Nix checks through `nix-offload there` instead, which does it elsewhere, and search the zone you mean rather than the whole checkout.",
					]
				: []),
		],
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Timeout in seconds (optional, no default timeout). It measures the run: work waiting for its turn in the machine's queue starts it when its turn comes.",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description: `true to run it in the background at once. False or left out, a command still running after ${spoken(HAND_OFF_MS)} moves to the background; nothing waits longer.`,
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const definition = bashFor(ctx);
			return await runOrHandOff({
				command: params.command,
				toolCallId,
				session: sessionKeyOf(ctx),
				...(params.background !== undefined
					? { background: params.background }
					: {}),
				// pi numbers a script's calls under the call that ran it.
				nested: toolCallId.includes("/") || endsWithItsPrompts(ctx.mode),
				signal,
				onUpdate,
				bus: pi.events,
				carryOf: (owned) => definition.carryOf(owned),
				run: (owned, update) =>
					definition.execute(
						toolCallId,
						{
							command: params.command,
							...(params.timeout !== undefined
								? { timeout: params.timeout }
								: {}),
						},
						owned,
						update,
						ctx,
					),
			});
		},
	});
}
