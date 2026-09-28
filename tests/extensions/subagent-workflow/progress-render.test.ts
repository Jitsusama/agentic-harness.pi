/**
 * The fleet's board and the card that replaces it.
 *
 * The board leaves in the frame its card arrives, and pi draws the card
 * where the board's rows were. A card shorter than the board leaves the
 * difference as blank rows at the foot of the screen until something else
 * is drawn, so the card has to be at least as tall as the board ever was,
 * for every mix of outcomes, focused or not. That is the relation pinned
 * here; the screen test shows what breaking it looks like.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { FleetProgressEntry } from "../../../extensions/subagent-workflow/progress.ts";
import {
	fleetBoard,
	fleetCardLines,
	isFleetRunResult,
} from "../../../extensions/subagent-workflow/progress-render.ts";
import type {
	FleetRunResult,
	FleetSubagentResult,
} from "../../../extensions/subagent-workflow/run.ts";
import { boardLines } from "../../../lib/ui/board.ts";

/** A theme that returns its text, so assertions read as content. */
const theme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

type Outcome = FleetSubagentResult["state"];

/** A fleet that ended with these outcomes, one subagent each. */
function ended(outcomes: readonly Outcome[]): FleetRunResult {
	return {
		runId: "fleet-under-test",
		warnings: [],
		runDir: "/state/runs/fleet-under-test",
		results: outcomes.map((state, index) => ({
			id: `job-${index}`,
			finalAssistantText: "",
			warnings: [],
			state,
			...(state === "failed" ? { error: `exit 1: broke ${index}` } : {}),
			resultPath: `/state/runs/fleet-under-test/job-${index}/result.json`,
		})),
	};
}

/** The same fleet as its board saw it just before it ended. */
function asEntries(result: FleetRunResult): FleetProgressEntry[] {
	return result.results.map((one) => ({
		spec: { id: one.id },
		state: one.state,
		warnings: [],
		error: one.error ?? "",
		activity: "",
	}));
}

const MIXES: readonly (readonly Outcome[])[] = [
	["complete"],
	["failed"],
	["cancelled"],
	["complete", "complete", "complete"],
	["failed", "failed", "failed", "failed"],
	["complete", "failed", "cancelled", "failed", "complete"],
];

describe("the card a fleet leaves behind", () => {
	for (const mix of MIXES) {
		it(`is at least as tall as its board, for ${mix.join(", ")}`, () => {
			const result = ended(mix);
			const card = fleetCardLines(result, theme, false);
			for (const focused of [false, true]) {
				const board = boardLines(
					fleetBoard(asEntries(result), theme, { selected: 0, notice: "" }),
					theme,
					100,
					focused,
				);
				expect(card.length).toBeGreaterThanOrEqual(board.length);
			}
		});
	}

	it("names every subagent with its outcome, and each failure's reason", () => {
		const card = fleetCardLines(
			ended(["complete", "failed", "cancelled"]),
			theme,
			false,
		).join("\n");

		expect(card).toContain("1/3 done");
		expect(card).toMatch(/complete job-0/);
		expect(card).toMatch(/failed job-1/);
		expect(card).toMatch(/cancelled job-2/);
		expect(card).toContain("job-1: exit 1: broke 1");
	});

	it("says where the full output is, and with room each subagent's file", () => {
		const result = ended(["complete", "complete"]);

		const collapsed = fleetCardLines(result, theme, false).join("\n");
		const expanded = fleetCardLines(result, theme, true).join("\n");

		expect(collapsed).toContain("full output: /state/runs/fleet-under-test");
		expect(collapsed).not.toContain("result.json");
		expect(expanded).toContain(
			"job-1 → /state/runs/fleet-under-test/job-1/result.json",
		);
	});

	it("draws only details that are a fleet's result", () => {
		expect(isFleetRunResult(ended(["complete"]))).toBe(true);
		expect(isFleetRunResult({ ok: false })).toBe(false);
		expect(isFleetRunResult({ results: [{ id: 3 }] })).toBe(false);
		expect(isFleetRunResult(undefined)).toBe(false);
	});
});

describe("the board", () => {
	it("says how to reach its keys until it has them, then what they are", () => {
		const board = fleetBoard(asEntries(ended(["complete"])), theme, {
			selected: 0,
			notice: "",
		});

		const unfocused = boardLines(board, theme, 120, false).join("\n");
		const focused = boardLines(board, theme, 120, true).join("\n");

		expect(unfocused).toContain("Ctrl+Alt+N to manage");
		expect(unfocused).not.toContain("r cancel selected");
		expect(focused).toContain("r cancel selected");
		expect(focused).toContain("Esc cancel fleet");
	});

	it("marks the selection with a cursor, not only by colour", () => {
		const board = fleetBoard(
			asEntries(ended(["complete", "complete"])),
			theme,
			{ selected: 1, notice: "" },
		);

		expect(board.rows[1]).toMatch(/^▸ /);
		expect(board.rows[0]).toMatch(/^ {2}/);
	});
});
