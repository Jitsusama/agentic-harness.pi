/**
 * The batch progress is set and cleared by the prompt, not by its callers.
 *
 * A status line entry nobody clears is worse than no status line entry: it
 * says the session is halfway through a batch that finished ten minutes
 * ago. Putting both halves inside `showTabbedPrompt` means no caller can
 * forget, and putting the clear in a `finally` covers every way out at
 * once, including the ones nobody thought to enumerate.
 *
 * These tests drive the real function with a fake `ctx.ui`, because what
 * is being checked is the lifecycle around the panel rather than anything
 * the panel draws.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { showTabbedPrompt } from "../../../lib/ui/prompt-tabbed.js";
import type { TabbedPromptConfig } from "../../../lib/ui/types.js";

/** A ctx that records status writes and answers `custom` however told to. */
function context(custom: () => Promise<unknown>) {
	const writes: { key: string; text: string | undefined }[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				writes.push({ key, text });
			},
			custom,
		},
	} as unknown as ExtensionContext;
	return { ctx, writes };
}

/** Two items, which is enough to have a denominator. */
const CONFIG = {
	title: "Post 2 things?",
	items: [
		{ label: "T26", content: () => ["one"] },
		{ label: "T27", content: () => ["two"] },
	],
} as unknown as TabbedPromptConfig;

describe("batch progress on the status line", () => {
	it("says nothing has been decided yet when the panel opens", async () => {
		const { ctx, writes } = context(async () => null);
		await showTabbedPrompt(ctx, CONFIG);
		expect(writes[0]?.text).toContain("0/2");
	});

	it("clears it when the panel is submitted", async () => {
		const { ctx, writes } = context(async () => ({
			items: new Map(),
			userItems: [],
		}));
		await showTabbedPrompt(ctx, CONFIG);
		expect(writes.at(-1)?.text).toBeUndefined();
	});

	it("clears it when the panel is cancelled", async () => {
		const { ctx, writes } = context(async () => null);
		await showTabbedPrompt(ctx, CONFIG);
		expect(writes.at(-1)?.text).toBeUndefined();
	});

	it("clears it even when the panel throws, which nothing else would", async () => {
		const { ctx, writes } = context(async () => {
			throw new Error("the terminal went away");
		});
		await expect(showTabbedPrompt(ctx, CONFIG)).rejects.toThrow(
			"the terminal went away",
		);
		expect(writes.at(-1)?.text).toBeUndefined();
	});

	it("writes every update under one key, so nothing is orphaned", async () => {
		const { ctx, writes } = context(async () => null);
		await showTabbedPrompt(ctx, CONFIG);
		expect(new Set(writes.map((one) => one.key)).size).toBe(1);
	});
});
