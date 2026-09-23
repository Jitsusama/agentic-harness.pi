/**
 * Browser Integration extension.
 *
 * A family of tools over named, persistent browser sessions,
 * named for what the caller is doing: browser_go to be
 * somewhere and to set the conditions, browser_see to read the
 * page, browser_do to change it, browser_check to form a
 * verdict about it. Elements are named the way they read in the
 * accessibility outline, so the same vocabulary works for
 * seeing and for acting.
 *
 * Sessions dispose after a stretch with no activity and again
 * at shutdown, on the hardened shared browser lifecycle, so
 * nothing leaks and nothing is closed mid-call.
 *
 * No slash command: the agent (or a subagent) drives the tools.
 *
 * An interactive or RPC session carries the tools only once browser
 * work starts; see `tool-surface.ts`. A subagent runs in json mode with
 * whatever palette it was given, which is left alone.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCheck } from "./check.ts";
import { registerDo } from "./do.ts";
import { registerGo } from "./go.ts";
import { createSessionRegistry } from "./registry.ts";
import { registerSee } from "./see.ts";
import {
	browserToolSurface,
	calledBrowserBefore,
	readsBrowserSkill,
} from "./tool-surface.ts";

/** Modes whose tool surface is this extension's to shape. */
const SHAPED_MODES: ReadonlySet<string> = new Set(["tui", "rpc"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Names of every tool an assistant called in a session's entries. */
function calledToolNames(entries: readonly unknown[]): string[] {
	const names: string[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || !isRecord(entry.message)) continue;
		const { role, content } = entry.message;
		if (role !== "assistant" || !Array.isArray(content)) continue;
		for (const block of content) {
			if (isRecord(block) && block.type === "toolCall") {
				if (typeof block.name === "string") names.push(block.name);
			}
		}
	}
	return names;
}

export default function browserIntegration(pi: ExtensionAPI) {
	const registry = createSessionRegistry();
	let engaged = false;

	const applyToolSurface = (): void => {
		pi.setActiveTools(
			browserToolSurface(
				pi.getActiveTools(),
				pi.getAllTools().map((tool) => tool.name),
				engaged,
			),
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!SHAPED_MODES.has(ctx.mode)) return;
		engaged = calledBrowserBefore(
			calledToolNames(ctx.sessionManager.getBranch()),
		);
		applyToolSurface();
	});

	pi.on("tool_result", async (event, ctx) => {
		if (engaged || !SHAPED_MODES.has(ctx.mode)) return;
		if (!readsBrowserSkill(event.toolName, event.input)) return;
		engaged = true;
		applyToolSurface();
	});

	pi.on("session_shutdown", async () => {
		await registry.disposeAll();
	});

	registerGo(pi, registry);
	registerSee(pi, registry);
	registerDo(pi, registry);
	registerCheck(pi, registry);
}
