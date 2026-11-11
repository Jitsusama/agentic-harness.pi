/**
 * A zoom drawn when it is pressed.
 *
 * The zoom chords are taken by a terminal-input listener, which runs
 * before pi hands a key to what has focus, and pi redraws after a key
 * only once it gets that far. So a panel's new height waited for
 * whatever drew next: on a hosted screen with nothing else drawing, it
 * never showed. Each mount now asks for a draw when the height changes.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { withSession } from "../../../lib/core/session/index.ts";
import { dock } from "../../../lib/ui/dock.ts";
import { view } from "../../../lib/ui/panel.ts";
import { setPanelHeightMode } from "../../../lib/ui/panel-height.ts";
import { installTestHost } from "../../support/session-host.ts";
import { type PiScreen, pinStdout, piScreen } from "./pi-screen.ts";

const ESCAPE = "\x1b";
const ROWS = 50;

/** A body of distinct, countable lines, longer than the screen. */
function lines(count: number): string[] {
	return Array.from({ length: count }, (_, at) => `line ${at + 1}`);
}

/** Whether a numbered line is on screen, as itself rather than a prefix. */
function showsLine(screen: string, line: number): boolean {
	return new RegExp(`\\bline ${line}\\b`).test(screen);
}

/** A docked widget's context, its draws counted. */
function counted(): { ctx: ExtensionContext; draws: () => number } {
	let draws = 0;
	const tui = {
		children: [],
		terminal: { rows: 24, columns: 80 },
		requestRender() {
			draws += 1;
		},
		setFocus() {},
	} as unknown as TUI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			theme: {},
			setWidget: (_key: string, factory: unknown) => {
				if (typeof factory === "function") factory(tui, {});
			},
			onTerminalInput: () => () => {},
		},
	} as unknown as ExtensionContext;
	return { ctx, draws: () => draws };
}

const body = { render: () => ["a row"] };

describe("a zoom", () => {
	let s: PiScreen | undefined;
	let unpin: (() => void) | undefined;
	let host: ReturnType<typeof installTestHost> | undefined;

	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		s?.stop();
		s = undefined;
		unpin?.();
		unpin = undefined;
		if (host) {
			for (const id of ["a", "b"])
				withSession(id, () => setPanelHeightMode("normal"));
			host.dispose();
			host = undefined;
		} else setPanelHeightMode("normal");
	});

	it("draws an overlaid panel at its new height with no key after it", async () => {
		unpin = pinStdout(100, ROWS);
		s = piScreen(100, ROWS);
		const shown = view(s.ctx(), { content: () => lines(200) });
		expect(showsLine(await s.settled(), 25), "its normal share").toBe(true);

		setPanelHeightMode("fullscreen");

		// Nine tenths of 50 rows, less the view's five rows of chrome.
		const screen = await s.settled();
		expect(showsLine(screen, 40), "it fills the screen at once").toBe(true);
		expect(showsLine(screen, 41), "and no more than its share").toBe(false);

		s.terminal.press(ESCAPE);
		await shown;
	});

	it("leaves a closed panel's screen alone", async () => {
		unpin = pinStdout(100, ROWS);
		s = piScreen(100, ROWS);
		const shown = view(s.ctx(), { content: () => lines(200) });
		await s.settled();
		s.terminal.press(ESCAPE);
		await shown;
		let draws = 0;
		const requestRender = s.tui.requestRender.bind(s.tui);
		s.tui.requestRender = (force?: boolean) => {
			draws += 1;
			requestRender(force);
		};

		setPanelHeightMode("fullscreen");

		expect(draws, "nothing mounted asks for a draw").toBe(0);
	});

	it("draws a docked widget again until it is closed", () => {
		const { ctx, draws } = counted();
		const docked = dock(ctx, "zoom-draws-at-once", body);
		const before = draws();

		setPanelHeightMode("fullscreen");
		expect(draws(), "the dock draws its new share").toBe(before + 1);

		docked.close();
		const closed = draws();
		setPanelHeightMode("normal");
		expect(draws(), "a closed dock draws nothing").toBe(closed);
	});

	it("draws only the zoomed conversation's screen on a host", () => {
		host = installTestHost();
		const a = counted();
		const b = counted();
		const docks = [
			withSession("a", () => dock(a.ctx, "zoom-a", body)),
			withSession("b", () => dock(b.ctx, "zoom-b", body)),
		];
		const [aBefore, bBefore] = [a.draws(), b.draws()];

		withSession("a", () => setPanelHeightMode("fullscreen"));

		expect(a.draws(), "a's dock draws its new share").toBe(aBefore + 1);
		expect(b.draws(), "b's screen is not drawn for a's zoom").toBe(bBefore);
		withSession("a", () => docks[0]?.close());
		withSession("b", () => docks[1]?.close());
	});
});
