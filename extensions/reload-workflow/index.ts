/**
 * Reload workflow extension: the agent reloads its own session, onto
 * the tree under test when it wants to, and carries on once the reload
 * lands.
 *
 * The `reload` tool asks; when the run ends, `/harness reload` does it:
 * it points pi's entry for this package at the tree for as long as the
 * reload reads the settings, then puts the entry back. A tree is loaded
 * in a pi of its own first, and one that does not load is refused
 * before anything is touched. Every reload ends with the model told
 * which code now runs; a reload the agent asked for comes back as a
 * turn through the job host, so the work goes on, away mode included.
 *
 * While the session runs code other than the install, the footer shows
 * `⇄`, and `/harness` says what runs.
 */

import { homedir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	describeLoaded,
	type Loaded,
} from "../../lib/internal/reload/loaded.ts";
import { piPackageSettings } from "../../lib/internal/reload/settings.ts";
import { drawInto, firstText } from "../../lib/ui/index.ts";
import {
	PACKAGE_NAME,
	PACKAGE_ROOT,
	startRuntime,
	whatRuns,
} from "./lifecycle.ts";
import {
	COMMAND,
	callOff,
	INSTALLED,
	performReload,
	RELOAD_ARG,
	requestReload,
	takeForDispatch,
	treeToLoad,
} from "./transitions.ts";

/** Whether a settled run was stopped by the person. */
function settledAborted(event: unknown): boolean {
	return (
		typeof event === "object" &&
		event !== null &&
		"aborted" in event &&
		event.aborted === true
	);
}

export default function reloadWorkflow(pi: ExtensionAPI) {
	const settings = piPackageSettings();
	let running: Loaded = { root: PACKAGE_ROOT };

	pi.on("session_start", async (event, ctx) => {
		await startRuntime(pi, ctx, event.reason, settings, (loaded) => {
			running = loaded;
		});
	});

	// The run that asked has ended: hand the request to the command,
	// through pi's prompt path, which is what gives it `reload()`.
	pi.on("agent_settled", async (event, ctx: ExtensionContext) => {
		if (settledAborted(event)) {
			if (callOff()) {
				ctx.ui.notify("Reload called off: you stopped the run.", "info");
			}
			return;
		}
		if (takeForDispatch() === undefined) return;
		pi.sendUserMessage(`/${COMMAND} ${RELOAD_ARG}`, {
			expandPromptTemplates: true,
		});
	});

	pi.registerCommand(COMMAND, {
		description:
			"Say which harness code this session runs. `/harness reload` reloads onto it again, so a tree stays a tree.",
		handler: async (args, ctx) => {
			if (args.trim() === RELOAD_ARG) {
				await performReload(ctx, running, settings);
				return;
			}
			running = await whatRuns(settings);
			ctx.ui.notify(describeLoaded(PACKAGE_NAME, running), "info");
		},
	});

	pi.registerTool({
		name: "reload",
		label: "Reload",
		description:
			"Reload this session's extensions, onto a worktree of this harness or back onto its install, once the current run ends. A tree is loaded in a pi of its own first and refused if it does not load. When the reload lands, a message says which code runs, and the run carries on.",
		promptSnippet:
			"Reload the session onto a harness worktree, or its install, and carry on.",
		promptGuidelines: [
			"After changing this harness's extensions, call reload with onto set to the worktree, then exercise the change yourself; do not ask the user to reload, and do not fire the changed code path before the reload lands.",
			"After calling reload, end your turn with no further calls; the reload runs when the run ends, and a message starts the next turn.",
			`Reload onto "${INSTALLED}" once the change is merged and the install updated, so the session stops running the tree.`,
		],
		parameters: Type.Object({
			reason: Type.String({
				description:
					"Why, in a few words, said back when the reload lands, e.g. 'try the new footer mark'.",
			}),
			onto: Type.Optional(
				Type.String({
					description: `A worktree of this harness to load in place of its install, or "${INSTALLED}" for the install. Left out, the session reloads whatever it runs now.`,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			running = await whatRuns(settings);
			const tree = treeToLoad(params.onto, running, ctx.cwd, homedir());
			const text = await requestReload(
				params.reason,
				tree,
				settings,
				(progress) =>
					onUpdate?.({
						content: [{ type: "text", text: progress }],
						details: {},
					}),
			);
			return {
				content: [{ type: "text", text }],
				details: { tree: tree ?? null },
			};
		},
		renderCall(args, theme, context) {
			const onto = typeof args.onto === "string" ? ` ${args.onto}` : "";
			return drawInto(
				context?.lastComponent,
				theme.fg("toolTitle", theme.bold("reload")) + theme.fg("muted", onto),
			);
		},
		renderResult(result, _options, theme, context) {
			return drawInto(
				context?.lastComponent,
				theme.fg("muted", firstText(result).split(". ")[0] ?? ""),
			);
		},
	});
}
