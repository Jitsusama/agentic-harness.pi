/**
 * The resident block survives a reload or a resume byte for byte.
 *
 * It is frozen on a session's first prompt, but the freeze lived only
 * in memory, so a `/reload` or a resumed session assembled it again.
 * Its contributors change during a session (recalled memory takes in
 * every fact retained, captured rules every rule filed), so the system
 * prompt came back different and the next turn rewrote the whole
 * context at the cache-write price. Measured on 2026-09-24: breaks
 * falling back to the end of the tool definitions after a plain typed
 * message, at every size up to 330k. What was learned since is already
 * in the conversation, so nothing is lost by keeping the old bytes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import promptCoordinator from "../../../extensions/prompt-coordinator-workflow/index.ts";
import {
	clearPromptContributors,
	registerPromptContributor,
} from "../../../lib/prompt/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function activate() {
	const handlers = new Map<string, Handler>();
	const entries: Array<{ type: string; customType: string; data: unknown }> =
		[];
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", customType, data }),
	};
	promptCoordinator(pi as unknown as ExtensionAPI);
	const ctx = { cwd: "/work", sessionManager: { getEntries: () => entries } };
	const fire = (name: string, event: unknown) =>
		handlers.get(name)?.(event, ctx);
	const prompt = async () =>
		(
			(await fire("before_agent_start", { systemPrompt: "BASE" })) as {
				systemPrompt: string;
			}
		).systemPrompt;
	return { fire, prompt, entries };
}

afterEach(() => clearPromptContributors());

describe("the resident block across a reload", () => {
	it("renders the bytes it froze before the reload, not a fresh assembly", async () => {
		let remembered = "- fact one";
		registerPromptContributor({
			id: "memory",
			order: 10,
			contribute: () => remembered,
		});
		const { fire, prompt } = activate();

		await fire("session_start", { reason: "startup" });
		const before = await prompt();
		remembered = "- fact one\n- fact two";
		await fire("session_start", { reason: "reload" });
		const after = await prompt();

		expect(after).toBe(before);
	});

	it("records the frozen block once, not on every prompt", async () => {
		registerPromptContributor({
			id: "memory",
			order: 10,
			contribute: () => "- fact",
		});
		const { fire, prompt, entries } = activate();

		await fire("session_start", { reason: "startup" });
		await prompt();
		await prompt();

		expect(entries).toHaveLength(1);
	});

	it("assembles afresh for a session that never froze one", async () => {
		let remembered = "- old";
		registerPromptContributor({
			id: "memory",
			order: 10,
			contribute: () => remembered,
		});
		const first = activate();
		await first.fire("session_start", { reason: "startup" });
		await first.prompt();

		remembered = "- new";
		const second = activate();
		await second.fire("session_start", { reason: "new" });

		expect(await second.prompt()).toBe("BASE\n\n- new");
	});
});
