/**
 * The propose gate, drawn like the rest of the surface.
 *
 * This is the gate a person reads before a change goes up, and it was
 * the last one still joining strings and handing them to the word
 * wrapper. A PR body is the most markdown-heavy text this package
 * produces, so wrapping it raw showed the section headings as literal
 * `### 🌐 Situation` and left every line flush against the margin,
 * beside neighbouring gates that render and inset the same text.
 *
 * How a panel is drawn in general belongs to review-gate-panel; this is
 * only about the panel propose builds. The seam is that panel: build it
 * here, assert what it draws, and leave the terminal to the thin call
 * that shows it. `gate.ts` needs no change, since it already takes one.
 */

import { describe, expect, it } from "vitest";
import {
	type BodyRenderer,
	type GatePanel,
	gateLines,
} from "../../extensions/review-integration/render.js";
import {
	closePanel,
	editPanel,
	proposePanel,
} from "../../extensions/review-integration/tools/offer.js";
import { fakeTheme } from "../lib/ui/fake-theme.js";

const WIDTH = 72;

/** Stands in for pi's markdown, marking whatever it was handed. */
const marked: BodyRenderer = (body, width) =>
	body.split("\n").map((line) => `<md:${width}>${line}`);

/** A body shaped the way the PR format requires. */
const BODY = [
	"### 🌐 Situation",
	"",
	"The gate word-wrapped a raw string.",
	"",
	"### 🔧 Resolution",
	"",
	"It builds a panel now.",
].join("\n");

const proposal = {
	head: "topic",
	base: "main",
	repo: "meteorite:shop/world",
	title: "Draw the Propose Gate Like Its Neighbours",
	body: BODY,
	draft: true,
};

/** The rendered panel as one string, which is how a person reads it. */
function drawn(panel: GatePanel, width = WIDTH): string {
	return gateLines(panel, fakeTheme(), width, marked).join("\n");
}

describe("the propose gate", () => {
	it("sends the body through the renderer rather than wrapping it raw", () => {
		const shown = drawn(proposePanel(proposal));

		// Every payload line went through the renderer, so the headings are
		// the renderer's problem and not a literal `###` on screen.
		expect(shown).toContain("<md:");
		expect(shown).toContain("The gate word-wrapped a raw string.");
	});

	it("insets the body instead of leaving it flush at the margin", () => {
		const shown = drawn(proposePanel(proposal));
		const line = shown
			.split("\n")
			.find((one) => one.includes("It builds a panel now."));

		expect(line).toBeDefined();
		expect(line?.startsWith(" ")).toBe(true);
	});

	it("names where the change is going, since the checkout cannot say", () => {
		const shown = drawn(proposePanel(proposal));

		expect(shown).toContain("meteorite:shop/world");
		expect(shown).toContain("topic");
		expect(shown).toContain("main");
	});

	it("says a draft is a draft", () => {
		expect(drawn(proposePanel(proposal))).toMatch(/draft/i);
		expect(drawn(proposePanel({ ...proposal, draft: false }))).not.toMatch(
			/draft/i,
		);
	});

	it("carries the guesses, the warnings and the ask as consequence", () => {
		const shown = drawn(
			proposePanel({
				...proposal,
				guessed: ["base", "head"],
				warnings: ["the head is behind its upstream"],
				reviewers: ["alice", "bob"],
			}),
		);

		expect(shown).toContain("base, head");
		expect(shown).toContain("the head is behind its upstream");
		expect(shown).toContain("alice, bob");
	});

	it("leaves out what it has nothing to say about", () => {
		// A gate that prints an empty "Taken from the checkout:" teaches
		// people to skim it.
		const shown = drawn(proposePanel(proposal));

		expect(shown).not.toMatch(/taken from the checkout/i);
		expect(shown).not.toMatch(/asking/i);
	});
});

describe("the edit gate", () => {
	const label = "shop/world#2000980";

	it("shows a new body whole, rather than the first 200 characters", () => {
		// The payload is the thing a gate exists to show, so it is never
		// clipped. A body edit used to be sliced at 200 characters, which is
		// mid-sentence for the shortest PR body this package will write.
		const body = `${"A sentence that keeps going. ".repeat(12)}THE END`;
		const shown = drawn(
			editPanel({ label, edits: { body: { action: "set", value: body } } }),
		);

		expect(body.length).toBeGreaterThan(200);
		expect(shown).toContain("THE END");
		expect(shown).toContain("<md:");
	});

	it("still says which way a list edit is going", () => {
		// "labels: risky" reads as a replacement and usually is not one.
		const shown = drawn(
			editPanel({
				label,
				edits: {
					labels: { action: "add", value: ["risky"] },
					base: { action: "set", value: "main" },
					title: { action: "clear" },
				},
			}),
		);

		expect(shown).toContain("labels: add risky");
		expect(shown).toContain("base: main");
		expect(shown).toContain("title: cleared");
	});

	it("leads with a caution when there is one", () => {
		const shown = drawn(
			editPanel({
				label,
				edits: { base: { action: "set", value: "main" } },
				caution: "this ejects the change from the merge queue",
			}),
		);

		expect(shown).toContain("this ejects the change from the merge queue");
	});
});

describe("the close gate", () => {
	const label = "shop/world#2000980";

	it("renders the reason being left on the change", () => {
		const shown = drawn(
			closePanel({ label, comment: "Superseded by **#2001696**." }),
		);

		expect(shown).toContain("<md:");
		expect(shown).toContain("Superseded by **#2001696**.");
	});

	it("says plainly when no reason will be left", () => {
		// Silence on a closed change reads as abandonment, so the gate says
		// so rather than leaving the absence to be noticed.
		const shown = drawn(closePanel({ label }));

		expect(shown).toMatch(/abandonment/i);
	});
});
