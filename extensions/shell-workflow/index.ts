/**
 * Shell Workflow Extension
 *
 * Registers `bash` as pi's own bash tool, built with the same settings,
 * with two changes. The agent's commands run with no interactive editor
 * or pager, since nobody is at the keyboard to leave one. And a command
 * still running after five minutes is handed to job-workflow rather than
 * holding the session silently: the call returns saying so, and the job
 * says how the command ended. A model expecting a long run passes
 * `background`; a codemode script's calls are never handed off.
 *
 * Everything else, the output truncation, the saved full output, the
 * rendering and the structured result codemode reads, is pi's.
 */

import {
	type BashToolOptions,
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { placedCommand } from "../../lib/internal/priority/place.ts";
import { withoutInteraction } from "./environment.ts";
import { HAND_OFF_MS, runOrHandOff, spoken } from "./hand-off.ts";

type BashDefinition = ReturnType<typeof createBashToolDefinition>;

/** The settings pi builds its own bash with, as this project sees them. */
function shellSettings(ctx: ExtensionContext): BashToolOptions {
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
		bash ??= createBashToolDefinition(ctx.cwd, {
			...shellSettings(ctx),
			// The shell moves itself into jobs before it runs anything, where
			// priority-workflow is placing what pi starts there.
			spawnHook: (context) =>
				withoutInteraction({
					...context,
					command: placedCommand(context.command),
				}),
		});
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
		],
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(
				Type.Number({
					description: "Timeout in seconds (optional, no default timeout)",
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
