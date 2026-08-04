/**
 * V1 and V4 of the validation plan: a gate row must fit the panel it is
 * drawn in, at every width and for every markdown construct a PR body uses.
 *
 * The panel truncates what it is handed, so a row wider than the panel is
 * not a wrapped row, it is a row with its end cut off, and nothing says so.
 * That is how the repo key went missing from the propose gate's header: the
 * destination row reaches 99 columns for an ordinary branch name and was the
 * only unwrapped row in the panel.
 *
 * Two things about measuring it. `initTheme` is needed even though the theme
 * is passed in, because `renderMarkdown` reaches past its argument for pi's
 * global markdown theme, which is why a panel had never been rendered in a
 * test before. And the fake theme marks colour with literal tags that
 * `visibleWidth` counts as visible, so they are stripped before measuring or
 * the test reports a row half again as wide as the panel draws. Pi's real
 * theme instance would avoid the stripping, but the package barrel exports
 * the `Theme` class rather than the live instance.
 *
 * Rows shorter than the panel are not checked here. They are covered by
 * `opaqueRow`, and until that landed a short row was a window onto the
 * transcript underneath.
 */

import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { gateLines } from "../../extensions/review-integration/render.js";
import { proposePanel } from "../../extensions/review-integration/tools/offer.js";
import { fakeTheme } from "../lib/ui/fake-theme.js";

/** A row as the terminal sees it, without the fake theme's markers. */
function asDrawn(row: string): string {
	return row.replace(/<\/?[a-z:]+>/g, "");
}

/** The widths a person actually runs a terminal at, narrow ones included. */
const WIDTHS = [60, 80, 100, 120, 200];

/** A body carrying the closed section set, as the format requires. */
const BODY = [
	"### 🌐 Situation",
	"",
	"A gate opened over busy output drew that output between its own lines.",
	"Reported as the panel being visually broken, and that was accurate.",
	"",
	"### 🔧 Resolution",
	"",
	"Every row goes through `opaqueRow`, padded by visible width so a styled",
	"row is not left short by the length of its own escape codes.",
	"",
	"### 🔬 Validation",
	"",
	"5272 tests pass across 496 files.",
].join("\n");

/** Every row of the propose gate, drawn as the panel will draw it. */
function rowsAt(width: number, body = BODY): string[] {
	return gateLines(
		proposePanel({
			head: "jitsusama/judge-quoted-write-targets",
			base: "main",
			repo: "github:Jitsusama/agentic-harness.pi",
			title: "Make a Panel Cover What It Is Drawn Over",
			body,
			draft: false,
			guessed: ["base", "head"],
		}),
		fakeTheme(),
		width,
	);
}

/** The rows that overrun, named by position so a failure says which. */
function overrunning(rows: string[], width: number): string[] {
	return rows
		.map((row, at) => ({ at, width: visibleWidth(asDrawn(row)) }))
		.filter((row) => row.width > width)
		.map((row) => `row ${row.at}: ${row.width} of ${width}`);
}

describe("a propose gate fits the panel it is drawn in", () => {
	beforeAll(() => {
		// Without a watcher: a test that leaves a file watcher running keeps
		// the worker alive after the suite has finished.
		initTheme(undefined, false);
	});

	for (const width of WIDTHS) {
		it(`at ${width} columns`, () => {
			expect(overrunning(rowsAt(width), width)).toEqual([]);
		});
	}

	it("wraps the header rather than letting the repo key fall off", () => {
		// The regression this came from. At 60 columns the destination row is
		// wider than the panel, so the end of it is what gets cut, and the end
		// is the repo key: the one thing on that row the checkout cannot say.
		const rows = rowsAt(60).join("\n");

		expect(rows).toContain("agentic-harness.pi");
	});
});

describe("a body's markdown constructs fit too", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	const constructs: Array<[string, string]> = [
		[
			"a fenced code block",
			"### 🌐 Situation\n\n```ts\nconst x = someFunctionWithARatherLongName(argument, other);\n```\n",
		],
		[
			"a table",
			"### 🌐 Situation\n\n| Column | Another column | A third |\n| --- | --- | --- |\n| value | another value | third |\n",
		],
		[
			"an unbroken url",
			"### 🌐 Situation\n\nSee https://github.com/Jitsusama/agentic-harness.pi/actions/runs/30940299345/job/92096679789 for it.\n",
		],
		[
			"a nested list",
			"### 🌐 Situation\n\n- One\n  - Nested, and rather long so that it has to wrap somewhere\n    - Deeper still\n",
		],
		[
			"a quote",
			"### 🌐 Situation\n\n> Quoted text that runs on for a while.\n",
		],
	];

	for (const [name, body] of constructs) {
		it(name, () => {
			for (const width of WIDTHS) {
				expect(overrunning(rowsAt(width, body), width)).toEqual([]);
			}
		});
	}
});
