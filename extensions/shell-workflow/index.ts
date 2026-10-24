/**
 * Shell Workflow Extension
 *
 * Registers `bash` as pi's own bash tool, built with the same settings,
 * with four changes. The agent's commands run with no interactive editor
 * or pager, since nobody is at the keyboard to leave one. Each command is
 * kept off its shell's command line, so `pkill -f` with a pattern from it
 * kills what it names rather than the shell running it. A time limit on
 * work the machine's queue holds starts when its turn does, not while it
 * waits (lib/internal/priority/clock.ts). And a command
 * still running after five minutes is handed to job-workflow rather than
 * holding the session silently: the call returns saying so, and the job
 * says how the command ended. A model expecting a long run passes
 * `background`; a codemode script's calls are never handed off.
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
import { agentBash, type ShellSettings } from "./agent-bash.ts";
import { HAND_OFF_MS, runOrHandOff, spoken } from "./hand-off.ts";

type BashDefinition = ReturnType<typeof createBashToolDefinition>;

/** The settings pi builds its own bash with, as this project sees them. */
function shellSettings(ctx: ExtensionContext): ShellSettings {
	try {
		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
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

export default function shellWorkflow(pi: ExtensionAPI) {
	// The shape pi's bash is drawn and described with; execution is per session.
	const shape = createBashToolDefinition(process.cwd());
	let bash: BashDefinition | undefined;

	const bashFor = (ctx: ExtensionContext): BashDefinition => {
		bash ??= agentBash(ctx.cwd, shellSettings(ctx));
		return bash;
	};

	pi.on("session_start", async (_event, ctx) => {
		bash = undefined;
		bashFor(ctx);
	});

	pi.registerTool({
		...shape,
		description: `${shape.description} A command still running after ${spoken(HAND_OFF_MS)} moves to the background, and its result arrives later as a message of its own.`,
		promptGuidelines: [
			...(shape.promptGuidelines ?? []),
			"Let a command's output through: do not pipe it into tail or head to keep it short, since bash already keeps the end and saves the full output to a file, and a pipe hides all progress until the command ends.",
			"Do not sleep in bash to wait for something. Pass background: true for a command expected to run long, or use a tool's own watch, and carry on; the result arrives as its own message.",
			// Only where commands are placed in the jobs cgroup: elsewhere
			// nice still ranks a command against what the person uses.
			...(process.env.JOBS_CGROUP
				? [
						"Do not add nice or ionice to a command. Every command already runs in a cgroup below everything the person uses, where nice only ranks it against other agents' work: a niced VM test loses to every build beside it and times out, and a niced nix build slows only its own evaluation, since the Nix daemon does the building.",
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
					description: `true to run it in the background at once, false to wait however long it takes. Left out, a command still running after ${spoken(HAND_OFF_MS)} moves to the background.`,
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const definition = bashFor(ctx);
			return await runOrHandOff({
				command: params.command,
				toolCallId,
				...(params.background !== undefined
					? { background: params.background }
					: {}),
				// pi numbers a script's calls under the call that ran it.
				nested: toolCallId.includes("/"),
				signal,
				onUpdate,
				bus: pi.events,
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
