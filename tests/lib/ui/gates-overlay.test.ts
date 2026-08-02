/**
 * A gate is shown over the transcript, not appended below it.
 *
 * Pi's `ctx.ui.custom` has two modes. Given `overlay`, it composites the
 * panel across the lines already on screen. Without it, the panel goes
 * into the editor container and the rendered content grows by the height
 * of the panel, which pushes the top of the transcript above the
 * viewport. Anything pushed up there is in the terminal's scrollback and
 * can never be rewritten, so a tool row painted before the gate opened is
 * stranded, and the same row painted again after the gate closes appears
 * a second time below it. That is the ghost.
 *
 * Nothing reconciles it afterwards, either: pi's `clearOnShrink` would
 * force a full redraw when the panel goes away, and it is off unless
 * `PI_CLEAR_ON_SHRINK=1` is set.
 *
 * So the mode is the fix, and these pin it. They assert the option
 * reaches pi rather than anything about what the panel draws, because
 * the fault was never in the drawing.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { showSinglePrompt } from "../../../lib/ui/prompt-single.js";
import { showTabbedPrompt } from "../../../lib/ui/prompt-tabbed.js";
import type {
	SinglePromptConfig,
	TabbedPromptConfig,
} from "../../../lib/ui/types.js";

/** Options pi was handed, and an immediate cancel so nothing blocks. */
function context() {
	const seen: { options?: Record<string, unknown> }[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: () => {},
			custom: async (_factory: unknown, options?: Record<string, unknown>) => {
				seen.push({ options });
				return null;
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, seen };
}

const SINGLE = {
	title: "Run CI Again on owner/repo#1",
	content: () => ["one line"],
} as unknown as SinglePromptConfig;

const TABBED = {
	title: "Post 2 Things",
	items: [
		{ label: "T1", content: () => ["one"] },
		{ label: "T2", content: () => ["two"] },
	],
} as unknown as TabbedPromptConfig;

describe("a gate panel", () => {
	it("is shown as an overlay, so the transcript is not pushed up", async () => {
		const { ctx, seen } = context();

		await showSinglePrompt(ctx, SINGLE);

		expect(seen[0]?.options?.overlay).toBe(true);
	});

	it("is shown as an overlay when it carries tabs too", async () => {
		// The batch gate is the taller of the two, so it pushes hardest.
		const { ctx, seen } = context();

		await showTabbedPrompt(ctx, TABBED);

		expect(seen[0]?.options?.overlay).toBe(true);
	});

	it("spans the width and sits at the bottom, where the editor was", async () => {
		// Overlay mode positions the panel itself, so without this it would
		// land centred and half-width: a working gate that looks like a
		// different product.
		const { ctx, seen } = context();

		await showSinglePrompt(ctx, SINGLE);

		expect(seen[0]?.options?.overlayOptions).toMatchObject({
			width: "100%",
			anchor: "bottom-center",
		});
	});

	it("can never be taller than the terminal", async () => {
		// An overlay taller than the screen makes pi extend the working
		// area to fit it, which is the growth this whole change exists to
		// avoid.
		const { ctx, seen } = context();

		await showTabbedPrompt(ctx, TABBED);

		expect(seen[0]?.options?.overlayOptions).toMatchObject({
			maxHeight: "100%",
		});
	});
});
