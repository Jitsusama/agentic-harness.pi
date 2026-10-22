/**
 * Guard Policy Workflow Extension
 *
 * One place to see and switch every guard. Each guard declares a
 * class and a default mode (off, redirect or block) with the policy in
 * `lib/guardian/policy.ts`; this extension reads the package config's
 * `guards` section, keeps the session's overrides, draws reports in the
 * transcript and registers `/guards`.
 *
 * Without it every guard keeps its declared default, and reports have
 * nowhere to go, so a guard that is off lets the action through
 * unseen. A redirect still reaches the agent, since its refusal is the
 * tool result.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	listGuards,
	restoreSessionModes,
	selectorKeys,
	setSessionMode,
} from "../../lib/guardian/policy.ts";
import {
	GUARD_REPORT_ENTRY,
	isGuardReport,
	setGuardReportSink,
} from "../../lib/guardian/report.ts";
import { list } from "../../lib/internal/guardian/registry.ts";
import { view } from "../../lib/ui/index.ts";
import { guardsCompletions, parseGuardsCommand } from "./command.ts";
import { loadModes, saveModes } from "./lifecycle.ts";
import { guardReportLines, guardTableLines } from "./render.ts";

export default function guardPolicyWorkflow(pi: ExtensionAPI) {
	setGuardReportSink((report) => pi.appendEntry(GUARD_REPORT_ENTRY, report));

	pi.registerEntryRenderer(GUARD_REPORT_ENTRY, (entry, options, theme) => {
		const report = entry.data;
		if (!isGuardReport(report)) return undefined;
		return {
			render: (width: number) =>
				guardReportLines(report, theme, width, options.expanded),
			invalidate: () => {},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		await loadModes(ctx);
	});

	pi.registerCommand("guards", {
		description:
			"List every guard and its mode, or set one for this session: /guards <name|group|class|all> <off|redirect|block>, /guards reset",
		getArgumentCompletions: (argumentText) =>
			guardsCompletions(argumentText, selectorKeys()).map((value) => ({
				value,
				label: value,
			})),
		handler: async (args, ctx) => {
			const command = parseGuardsCommand(args, selectorKeys());
			switch (command.kind) {
				case "error":
					ctx.ui.notify(command.message, "warning");
					return;
				case "reset":
					restoreSessionModes({});
					saveModes(pi, ctx);
					ctx.ui.notify("Guards are back to config and defaults.", "info");
					return;
				case "set":
					setSessionMode(command.key, command.mode);
					saveModes(pi, ctx);
					ctx.ui.notify(
						`${command.key}: ${command.mode} for this session.`,
						"info",
					);
					return;
				case "list": {
					const outcomes = new Map(
						list().map((entry) => [entry.name, entry.lastOutcome]),
					);
					await view(ctx, {
						title: "Guards",
						content: (theme, width) =>
							guardTableLines(listGuards(), outcomes, theme, width),
					});
					return;
				}
			}
		},
	});
}
