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
import { focusedIn, roomForDock } from "../../lib/ui/pi-layout.ts";
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
