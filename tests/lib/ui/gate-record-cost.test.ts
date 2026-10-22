/**
 * An answered gate costs a frame nothing once it has settled.
 *
 * Every gate answered leaves its record in the transcript for the rest of
 * the session. A record measured what lay below it on every frame, and
 * drew it to measure it, which drew every record after it as well: each
 * gate answered doubled what every later frame cost, so a session that
 * had answered a dozen slowed its spinner to a crawl and stayed that way
 * until pi was restarted. These count the components drawn per frame.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { settleRecord } from "../../../lib/ui/gate-record.ts";

interface Screen {
	tui: TUI;
	chat: Component & { children: Component[] };
	/** A transcript line that counts its draws. */
	line: (text: string) => Component;
	/** Components on the screen that are not gate records. */
	components: () => number;
	/** Components drawn since the count was last reset. */
	drawn: () => number;
	reset: () => void;
}

function screen(messages: number): Screen {
	let count = 0;
	// Every line made is on the screen, so this is what one frame draws.
	let made = 0;
	const line = (text: string): Component => {
		made++;
		return {
			render: () => {
				count++;
				return [text];
			},
			invalidate() {},
		};
	};
	const container = (children: Component[]) => ({
		children,
		render: (width: number) => children.flatMap((one) => one.render(width)),
		invalidate() {},
	});
	const chat = container(
		Array.from({ length: messages }, (_, i) => line(`message ${i}`)),
	);
	const document = container([container([line("header")]), chat]);
	const footer = container([line("status")]);
	const tui = {
		children: [document, footer],
		terminal: { rows: 45, columns: 120 },
		requestRender() {},
		render: (width: number) =>
			[document, footer].flatMap((one) => one.render(width)),
	} as unknown as TUI;
	return {
		tui,
		chat,
		line,
		components: () => made,
		drawn: () => count,
		reset: () => {
			count = 0;
		},
	};
}

/** The gate every record here is left by, as it stood when answered. */
const GATE = ["╭ gate", "│ a question", "╰ answered"];

/** Settles `gates` records, each followed by `between` new messages. */
function answer(at: Screen, gates: number, between: number): void {
	for (let gate = 0; gate < gates; gate++) {
		settleRecord(at.tui, GATE, "answered", 0);
		for (let i = 0; i < between; i++)
			at.chat.children.push(at.line(`after ${gate}.${i}`));
		at.tui.render(120);
	}
}

/** Components drawn in one frame, once the screen has settled. */
function frameCost(at: Screen): number {
	at.tui.render(120);
	at.reset();
	at.tui.render(120);
	return at.drawn();
}

describe("a settled gate record", () => {
	it("leaves a frame drawing each component once", () => {
		const at = screen(200);
		answer(at, 20, 10);

		// Every line, those after the records included, drawn once, and
		// nothing drawn again to measure anything.
		expect(frameCost(at)).toBe(at.components());
	});

	it("draws nothing extra however many gates came before", () => {
		for (const gates of [1, 5, 30]) {
			const at = screen(50);
			answer(at, gates, 5);
			expect(frameCost(at)).toBe(at.components());
		}
	});

	it("still gives its rows back as lines arrive below it", () => {
		const at = screen(0);
		settleRecord(at.tui, GATE, "answered", 0);
		for (let i = 0; i < 5; i++) {
			at.chat.children.push(at.line(`next ${i}`));
			at.tui.render(120);
		}

		// Down to its one row, saying what was decided.
		const rows = at.tui.render(120);
		expect(rows).toContain("answered");
		expect(rows).not.toContain("│ a question");
	});
});
