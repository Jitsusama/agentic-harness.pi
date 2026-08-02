/**
 * A gate that does not look like the others is a gate people stop reading.
 *
 * These pin the three places the review gates diverged from every other
 * confirmation in the package. Each one was found by looking at the panel
 * next to Slack's and Google's rather than by a test, which is why they are
 * written down now: the layout tests all assert on rows and were blind to
 * every one of them.
 *
 * The payload one is the reason this exists. Review bodies are the most
 * markdown-heavy text in the package, so word-wrapping them raw showed
 * literal asterisks and backticks where every neighbouring gate showed
 * formatted text.
 *
 * Markdown itself belongs to pi-tui and reaches for a global theme, so
 * what is pinned here is that the payload goes through the renderer and
 * that nothing else does. Whether bold comes out bold is pi's problem.
 */

import { describe, expect, it } from "vitest";
import {
	type BodyRenderer,
	type GatePanel,
	gateLines,
	gateText,
} from "../../extensions/review-integration/render.js";
import { fakeTheme } from "../lib/ui/fake-theme.js";

const WIDTH = 72;

/** Stands in for pi's markdown, marking whatever it was handed. */
const marked: BodyRenderer = (body, width) =>
	body.split("\n").map((line) => `<md:${width}>${line}`);

/** The address every panel here is pointed at. */
const HERE = "shop/world#2000980 · meteorite";

/** The rendered panel as one string, which is how a person reads it. */
function drawn(panel: GatePanel, width = WIDTH): string {
	return gateLines(panel, fakeTheme(), width, marked).join("\n");
}

describe("a gate that looks like its neighbours", () => {
	it("sends the payload through the renderer, not the raw wrapper", () => {
		const shown = drawn({
			destination: HERE,
			payload: { as: "replying", body: "Fixed in `0671cb0`, **finally**." },
		});
		expect(shown).toContain("<md:");
		expect(shown).toContain("Fixed in `0671cb0`, **finally**.");
	});

	it("renders every line of the payload, not just the first", () => {
		const shown = drawn({
			destination: HERE,
			payload: { as: "commenting", body: "- first\n- second" },
		});
		expect(shown).toContain("<md:");
		expect(shown).toContain("- first");
		expect(shown).toContain("- second");
	});

	it("leaves the chrome and the quotes alone, which are not the payload", () => {
		// Only the thing being sent is markdown. The destination is an
		// address and a quote is deliberately muted context.
		const shown = drawn({
			destination: HERE,
			context: [{ who: "binks", body: "have a look" }],
			payload: { as: "replying", body: "done" },
		});
		expect(shown).not.toContain("<md:>shop/world");
		expect(shown.match(/<md:/g)).toHaveLength(1);
	});

	it("keeps the plain text plain, since a redirect quotes it back", () => {
		// gateText feeds the redirect note, which is read by a model as
		// text. Escape codes there would be noise, so this one stays raw.
		const text = gateText(
			{
				destination: HERE,
				payload: { as: "replying", body: "Fixed in `0671cb0`." },
			},
			WIDTH,
		);
		expect(text).toContain("Fixed in `0671cb0`.");
		expect(text).not.toContain("<md:");
	});
});
