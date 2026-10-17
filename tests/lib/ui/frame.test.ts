/**
 * A panel's frame keeps the accent for keys.
 *
 * Wherever the accent shows on a panel it should mean "press this". The
 * edges, the title and the scrollbar were drawn in it too, so a gate wore
 * three greens that were not keys beside the one that was, and the keys
 * in the footer were drawn as muted as the words beside them. Now the
 * edges are in the rule colour, the title in the strongest text, the
 * scrollbar in the theme's scrollbar colours, and every key in the footer
 * in the accent with its word after it.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderFooter } from "../../../lib/ui/panel-layout.ts";
import { showSinglePrompt } from "../../../lib/ui/prompt-single.ts";
import { showTabbedPrompt } from "../../../lib/ui/prompt-tabbed.ts";
import { renderScrollRegion } from "../../../lib/ui/scroll-region.ts";
import type {
	SinglePromptConfig,
	TabbedPromptConfig,
} from "../../../lib/ui/types.ts";
import { fakeTheme } from "./fake-theme.ts";
import { pinStdout } from "./pi-screen.ts";

const WIDTH = 400;

type Factory = (
	tui: unknown,
	theme: Theme,
	keybindings: unknown,
	done: (result: unknown) => void,
) =>
	| { render(width: number): string[] }
	| Promise<{ render(width: number): string[] }>;

/** The panel a prompt hands pi, drawn once with every colour named. */
async function drawn(
	show: (ctx: ExtensionContext) => Promise<unknown>,
): Promise<string[]> {
	let factory: Factory | undefined;
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: () => {},
			custom: async (given: Factory) => {
				factory = given;
				return null;
			},
		},
	} as unknown as ExtensionContext;
	await show(ctx);
	if (!factory) throw new Error("the prompt never asked pi for a panel");
	const tui = {
		requestRender: () => {},
		terminal: { rows: 30, columns: WIDTH },
	};
	const panel = await factory(tui, fakeTheme(), undefined, () => {});
	return panel.render(WIDTH);
}

/** Everything drawn in the accent, in order. */
function accented(lines: string[]): string[] {
	return [...lines.join("\n").matchAll(/<accent>(.*?)<\/accent>/g)].map(
		(match) => match[1] ?? "",
	);
}

const SINGLE: SinglePromptConfig = {
	title: "Post This Reply",
	content: () => Array.from({ length: 80 }, (_, at) => `line ${at + 1}`),
	actions: [{ key: "r", label: "Reject" }],
};

const TABBED = {
	title: "Post 2 Things",
	items: ["one", "two"].map((text, at) => ({
		label: `T${at + 1}`,
		views: [{ key: "1", label: "Reply", content: () => [text] }],
	})),
} as unknown as TabbedPromptConfig;

describe("a panel's frame", () => {
	let unpin: () => void;

	beforeEach(() => {
		unpin = pinStdout(WIDTH, 30);
	});

	afterEach(() => {
		unpin();
	});

	it("draws its edges as hairlines in the rule colour", async () => {
		const lines = await drawn((ctx) => showSinglePrompt(ctx, SINGLE));

		// From the start only: the panel cuts each row to its width, and the
		// theme's markers count against it.
		expect(lines[0]).toMatch(/^<border>─{40}/);
		expect(lines.at(-1)).toMatch(/^<border>─{40}/);
	});

	it("draws its title bold in the strongest text", async () => {
		const lines = await drawn((ctx) => showSinglePrompt(ctx, SINGLE));

		expect(lines[1]).toBe(" <toolTitle><b>Post This Reply</b></toolTitle>");
	});

	it("draws its scrollbar in the theme's scrollbar colours", () => {
		// Drawn by the region alone: in a whole panel the theme's markers
		// count as visible width and push the gutter off the end of the row.
		const shown = renderScrollRegion(
			Array.from({ length: 40 }, (_, at) => `line ${at + 1}`),
			{ vOffset: 0, hOffset: 0 },
			10,
			40,
			fakeTheme(),
		).lines.join("\n");

		expect(shown).toContain("<scrollbarThumb>█</scrollbarThumb>");
		expect(shown).toContain("<scrollbarTrack>░</scrollbarTrack>");
	});

	it("spends the accent on keys and nothing else", async () => {
		const lines = await drawn((ctx) => showSinglePrompt(ctx, SINGLE));

		expect(accented(lines)).toEqual([
			"R",
			"⇧+key",
			"⇧+Esc",
			"⇧+↑↓",
			"Enter",
			"Esc",
		]);
	});

	it("marks the view being shown by its word, leaving the accent to its key", () => {
		const shown = renderFooter({
			theme: fakeTheme(),
			width: WIDTH,
			views: [
				{ key: "1", label: "Remark" },
				{ key: "2", label: "Anchor" },
			],
			activeViewIndex: 0,
		} as Parameters<typeof renderFooter>[0]).join("\n");

		expect(shown).toContain("[<accent>1</accent>] <text>Remark</text>");
		expect(shown).toContain("[<accent>2</accent>] <dim>Anchor</dim>");
	});

	it("gives every key it names a word saying what it does", async () => {
		const shown = (await drawn((ctx) => showTabbedPrompt(ctx, TABBED))).join(
			"\n",
		);

		expect(shown).toContain("<accent>Tab</accent> <dim>next</dim>");
		expect(shown).toContain("<accent>Ctrl+#</accent> <dim>go to</dim>");
		expect(shown).toContain("<accent>Esc</accent> <dim>cancel</dim>");
	});
});
