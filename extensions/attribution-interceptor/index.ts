/**
 * Attribution Interceptor Extension
 *
 * Injects AI co-authorship attribution into commits, PRs, and
 * issues created through Pi. Makes AI involvement transparent
 * for analytics tooling.
 *
 * Runs before guardians (alphabetical load order), so the user
 * sees the injected attribution during review. Returns undefined
 * to let subsequent handlers proceed with the modified command.
 *
 * On by default. Disable with --no-attribution flag.
 */

import {
	type ExtensionAPI,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@mariozechner/pi-coding-agent";
import { injectCommitAttribution, injectGhAttribution } from "./attribution.js";

export default function attributionExtension(pi: ExtensionAPI) {
	pi.registerFlag("no-attribution", {
		description:
			"Disable AI co-authorship attribution on commits, PRs and issues",
		type: "boolean",
		default: false,
	});

	pi.on(
		"tool_call",
		async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			if (!isToolCallEventType("bash", event)) return;
			if (!ctx.hasUI) return;
			if (pi.getFlag("no-attribution") === true) return;

			const command = event.input.command;
			const modelId = ctx.model?.id ?? null;

			const rewritten =
				injectCommitAttribution(command, modelId) ??
				injectGhAttribution(command, "pr", modelId) ??
				injectGhAttribution(command, "issue", modelId);

			if (rewritten) {
				(event.input as { command: string }).command = rewritten;
			}
		},
	);
}
