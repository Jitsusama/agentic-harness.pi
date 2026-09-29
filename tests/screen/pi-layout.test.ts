/**
 * The dock's reading of pi's screen, against the real pi.
 *
 * `lib/ui/pi-layout.ts` is the one module that reads what pi does not
 * publish: its component tree and two of its component classes. A pi that
 * moves them does not break loudly there. It answers `undefined`, the dock
 * falls back to half the terminal, and a person sees a board drawn at the
 * wrong height, or a transcript that flickers once a tick. So these boot
 * the pi this package is developed against and hold the reading to it.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	findEditor,
	focusedIn,
	markSettling,
	roomForDock,
	rowsAfter,
	rowsUnderGate,
	settleIntoChat,
} from "../../lib/ui/pi-layout.ts";
import { bootPi, type PiSession, waitFor } from "./pi-session.ts";

const COLS = 80;
const ROWS = 30;

/** A tool that runs until the test lets it go, drawing `ROWS_HELD` rows. */
const ROWS_HELD = 6;
let letGo: (() => void) | undefined;

function holdingTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "hold",
		label: "Hold",
		description: "Runs until released.",
		parameters: Type.Object({}),
		async execute() {
			await new Promise<void>((resolve) => {
				letGo = resolve;
			});
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
		renderCall(_args, theme) {
			return new Text(
				Array.from({ length: ROWS_HELD }, (_, i) =>
					theme.fg("toolTitle", `MARK-held-${i}`),
				).join("\n"),
				0,
				0,
			);
		},
	});
}

let pi: PiSession | undefined;

afterEach(async () => {
	letGo?.();
	letGo = undefined;
	await pi?.stop();
	pi = undefined;
});

const NONE: ReadonlySet<Component> = new Set();

function room(session: PiSession, streaming = false): number | undefined {
	return roomForDock(session.tui, COLS, NONE, streaming);
}

describe("reading pi's screen", () => {
	it("finds pi's layout before the first turn", async () => {
		pi = await bootPi({ cols: COLS, rows: ROWS, extensions: [holdingTool] });

		const idle = room(pi);

		expect(idle).toBeTypeOf("number");
		// The editor and footer take some rows; the rest is the dock's.
		expect(idle).toBeGreaterThan(ROWS / 2);
		expect(idle).toBeLessThan(ROWS);
	});

	it("finds what holds the keyboard, which the dock hands back to", async () => {
		pi = await bootPi({ cols: COLS, rows: ROWS, extensions: [holdingTool] });

		const focused = focusedIn(pi.tui);

		expect(focused).not.toBeNull();
		expect(focused).toBe(pi.focused());
		expect(pi.editorFocused()).toBe(true);
	});

	// Every way out of a widget hands the keys back to this, so a pi that
	// moved its editor would strand them on nothing.
	it("finds pi's editor in its tree while something else holds the keyboard", async () => {
		pi = await bootPi({ cols: COLS, rows: ROWS, extensions: [holdingTool] });
		const editor = pi.focused();
		pi.tui.setFocus(new Text("elsewhere", 0, 0));

		expect(pi.editorFocused()).toBe(false);
		expect(findEditor(pi.tui)).not.toBeNull();
		expect(findEditor(pi.tui)).toBe(editor);
	});

	it("finds it after a turn, and gives back what a finished turn held", async () => {
		const session = await bootPi({
			cols: COLS,
			rows: ROWS,
			extensions: [holdingTool],
		});
		pi = session;
		const before = room(session);

		session.answer(`MARK-answer ${"lorem ipsum ".repeat(40)}`);
		await session.prompt("a question");
		await waitFor(() => !session.runtime.session.isStreaming, "the turn");

		expect(before).toBeTypeOf("number");
		expect(room(session)).toBe(before);
	});

	it("keeps a running tool's rows out of the room, and gives them back after", async () => {
		const session = await bootPi({
			cols: COLS,
			rows: ROWS,
			extensions: [holdingTool],
		});
		pi = session;
		const idle = room(session);
		session.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {})),
			fauxAssistantMessage("MARK-done"),
		]);

		await session.prompt("hold on");
		await waitFor(() => letGo !== undefined, "the tool to start");
		await waitFor(() => session.onScreen("MARK-held-0"), "the tool's rows");
		const running = room(session, true);

		expect(running).toBeTypeOf("number");
		expect(running).toBeLessThanOrEqual((idle ?? 0) - ROWS_HELD);

		letGo?.();
		await waitFor(() => !session.runtime.session.isStreaming, "the turn");
		expect(room(session)).toBe(idle);
	});
});

/** Boots pi with the holding tool running, its rows on screen. */
async function holding(): Promise<PiSession> {
	const session = await bootPi({
		cols: COLS,
		rows: ROWS,
		extensions: [holdingTool],
	});
	pi = session;
	session.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("hold", {})),
		fauxAssistantMessage("MARK-done"),
	]);
	await session.prompt("hold on");
	await waitFor(() => letGo !== undefined, "the tool to start");
	await waitFor(() => session.onScreen("MARK-held-0"), "the tool's rows");
	return session;
}

/** A record of one row, settling while `live` says so. */
function recordOf(text: string, live: { now: boolean }): Component {
	const record: Component = { render: () => [text], invalidate() {} };
	markSettling(record, () => live.now);
	return record;
}

describe("placing a gate's record in pi's transcript", () => {
	it("puts it before the tool still running, so it never moves", async () => {
		const session = await holding();

		const put = settleIntoChat(
			session.tui,
			recordOf("MARK-record", { now: false }),
		);
		session.tui.requestRender();
		await waitFor(() => session.onScreen("MARK-record"), "the record");

		expect(put).toBe(true);
		const shown = await session.viewport();
		const record = shown.findIndex((row) => row.includes("MARK-record"));
		const tool = shown.findIndex((row) => row.includes("MARK-held-0"));
		expect(record).toBeLessThan(tool);
	});

	it("counts a record still settling as one row of the changing tail", async () => {
		const session = await holding();
		const before = room(session, true);
		const live = { now: true };

		settleIntoChat(session.tui, recordOf("MARK-record", live));
		const settling = room(session, true);
		live.now = false;
		const settled = room(session, true);

		expect(before).toBeTypeOf("number");
		expect(settling).toBe((before ?? 0) - 1);
		expect(settled).toBe(before);
	});

	it("measures what stands below a record and below a gate", async () => {
		const session = await holding();
		const record = recordOf("MARK-record", { now: false });
		settleIntoChat(session.tui, record);
		const gate: Component = { render: () => [], invalidate() {} };

		const after = rowsAfter(session.tui, record, COLS);
		const running = rowsUnderGate(session.tui, COLS, gate);
		letGo?.();
		await waitFor(() => !session.runtime.session.isStreaming, "the turn");
		const finished = rowsUnderGate(session.tui, COLS, gate);

		expect(after).toBeGreaterThanOrEqual(ROWS_HELD);
		expect(running).toBeTypeOf("number");
		expect(finished).toBeTypeOf("number");
		// The running tool is the tail; once it finishes nothing below can grow.
		expect((running ?? 0) - (finished ?? 0)).toBeGreaterThanOrEqual(ROWS_HELD);
	});
});
