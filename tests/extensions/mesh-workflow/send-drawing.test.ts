/**
 * mesh_send draws as pi draws a tool of no drawing of its own, and under
 * /mesh quiet draws no line at all until the person expands the screen.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	type SendContext,
	sendDrawing,
} from "../../../extensions/mesh-workflow/send-drawing.ts";

const theme = {
	fg: (_colour: string, text: string) => text,
	bg: (_colour: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

/** Wide enough that the call keeps to one line. */
const WIDTH = 100;

const args = { to: "orchestrator", intent: "fyi", text: "merged #1373" };
const answer = {
	content: [
		{ type: "text" as const, text: "Sent as QCXZEB: 21:10 [abc] fyi." },
	],
	details: undefined,
};

/** A row as pi keeps one: its state shared by the call and the result. */
function row(expanded = false): SendContext {
	return {
		state: {},
		isPartial: false,
		expanded,
		isError: false,
		outputPad: 1,
		lastComponent: undefined,
	};
}

/** The row's lines, call then result, as pi stacks them. */
function lines(quiet: () => boolean, expanded = false): string[] {
	const drawing = sendDrawing(quiet);
	const context = row(expanded);
	const call = drawing.renderCall(args, theme, context);
	const result = drawing.renderResult(
		answer,
		{ expanded, isPartial: false },
		theme,
		context,
	);
	return [...call.render(WIDTH), ...result.render(WIDTH)].map((line) =>
		line.trimEnd(),
	);
}

describe("a mesh_send row", () => {
	it("draws the frame pi draws: a blank line, the call, the answer, a blank line", () => {
		expect(lines(() => false)).toEqual([
			"",
			` mesh_send to="orchestrator" intent="fyi" text="merged #1373"`,
			" Sent as QCXZEB: 21:10 [abc] fyi.",
			"",
		]);
	});

	it("draws no line while the session is quiet", () => {
		expect(lines(() => true)).toEqual([]);
	});

	it("opens under quiet when the person expands the screen", () => {
		expect(lines(() => true, true)).toContain("   text: merged #1373");
	});

	it("follows quiet as it is drawn, so turning it on hides sends already shown", () => {
		let quiet = false;
		const drawing = sendDrawing(() => quiet);
		const call = drawing.renderCall(args, theme, row());
		expect(call.render(WIDTH)).not.toEqual([]);
		quiet = true;
		expect(call.render(WIDTH)).toEqual([]);
	});

	it("draws again into the row pi kept, so no old drawing is left beside it", () => {
		const drawing = sendDrawing(() => false);
		const first = drawing.renderCall(args, theme, row());
		const kept = { ...row(), lastComponent: first };
		const later = { ...args, text: "merged #1374" };
		const again = drawing.renderCall(later, theme, kept);
		expect(again).toBe(first);
		expect(first.render(WIDTH).join("\n")).toContain("merged #1374");
	});

	it("keeps the frame open below a call still waiting for its answer", () => {
		const drawing = sendDrawing(() => false);
		const call = drawing.renderCall(args, theme, row());
		expect(call.render(WIDTH).map((line) => line.trimEnd())).toEqual([
			"",
			` mesh_send to="orchestrator" intent="fyi" text="merged #1373"`,
			"",
		]);
	});
});
