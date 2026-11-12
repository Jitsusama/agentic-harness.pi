/**
 * A batch's progress stays in its panel, off the status line.
 *
 * The status line is kept for marks, and a bar with a count ("▓▓░░░ 2/7")
 * there was words beside them (Joel, 11 November: "way too much text in
 * the status bar"). The panel's tab strip already marks each item done,
 * active or pending, so the prompt says nothing on the status line.
 *
 * These tests drive the real function with a fake `ctx.ui`, because what
 * is being checked is what the panel's life writes outside it rather than
 * anything the panel draws.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { showTabbedPrompt } from "../../../lib/ui/prompt-tabbed.ts";
import type { TabbedPromptConfig } from "../../../lib/ui/types.ts";

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

describe("a batch's progress", () => {
	it("writes nothing to the status line while the panel is up or once it's answered", async () => {
		const { ctx, writes } = context(async () => ({
			items: new Map(),
			userItems: [],
		}));
		await showTabbedPrompt(ctx, CONFIG);

		expect(writes, "the status line is kept for marks").toEqual([]);
	});

	it("writes nothing to the status line when the panel is cancelled or throws", async () => {
		const cancelled = context(async () => null);
		await showTabbedPrompt(cancelled.ctx, CONFIG);
		const thrown = context(async () => {
			throw new Error("the terminal went away");
		});
		await expect(showTabbedPrompt(thrown.ctx, CONFIG)).rejects.toThrow(
			"the terminal went away",
		);

		expect(
			[...cancelled.writes, ...thrown.writes],
			"no way out leaves a mark behind",
		).toEqual([]);
	});
});
