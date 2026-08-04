/**
 * V9 of the validation plan: a panel has to be overlaid, all of them.
 *
 * `ctx.ui.custom` puts the component in the editor container by default,
 * which makes the rendered content taller by the height of the panel. What
 * scrolls off the top goes into the terminal's scrollback, where no later
 * redraw can reach it, so a row painted just before the panel opened is
 * stranded and the same row painted again afterwards reads as a duplicate.
 * That is the ghost, and `OVERLAID` is what prevents it.
 *
 * The rule was followed by the two prompt renderers and by nothing else.
 * Three panels a person actually opens, the content viewer, the toggle list
 * and the workspace prompt, went into the editor container. That is the same
 * shape as every other defect this plan has turned up: a rule held in one
 * place and checked in none, so half the surface quietly does not follow it.
 *
 * Checked as written, because whether a component was overlaid is a fact
 * about the call rather than about anything the call returns.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI = join(import.meta.dirname, "..", "..", "..", "lib", "ui");

/**
 * A call to open a panel, as opposed to a mention of one.
 *
 * A real call is followed by a type argument or an open bracket. Two files
 * describe the mechanism in prose, and matching those made the sweep report
 * the docstring explaining the rule as a violation of it.
 */
const OPENS_A_PANEL = /ui\.custom\s*[<(]/g;

/** How many panels a file opens. */
function callsIn(source: string): number {
	return source.match(OPENS_A_PANEL)?.length ?? 0;
}

/** Every file that opens a panel, found rather than listed, so a new one counts. */
function filesOpeningPanels(): string[] {
	return readdirSync(UI)
		.filter((name) => name.endsWith(".ts"))
		.filter((name) => callsIn(readFileSync(join(UI, name), "utf8")) > 0);
}

describe("every panel is drawn over the transcript", () => {
	it("finds the files that open one", () => {
		// Guards the sweep below against silently finding nothing.
		expect(filesOpeningPanels()).toEqual([
			"panel.ts",
			"prompt-single.ts",
			"prompt-tabbed.ts",
			"prompt-toggle-list.ts",
			"prompt-workspace.ts",
		]);
	});

	it("passes OVERLAID at every call", () => {
		const missing = filesOpeningPanels().filter((name) => {
			const source = readFileSync(join(UI, name), "utf8");
			const overlaid = source.split("OVERLAID").length - 1;
			// One use per call, plus the import that brought it in.
			return overlaid < callsIn(source) + 1;
		});

		expect(missing).toEqual([]);
	});
});
