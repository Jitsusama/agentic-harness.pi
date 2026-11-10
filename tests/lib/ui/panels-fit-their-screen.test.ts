/**
 * A panel sized for the screen it is drawn on, not the process's tty.
 *
 * Pi sizes what it draws from its terminal. On a host that terminal is
 * whoever views the conversation, and the process has no tty at all, so
 * a panel that read stdout sized itself for 40 rows on every screen: on
 * a small viewer pi clipped it, footer and all, and on a tall one it
 * used a strip. Here stdout is pinned to another size than pi's terminal,
 * as a host's is, so a panel that reads the wrong one shows it.
 */

import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderMarkdown } from "../../../lib/ui/content-renderer.ts";
import { view } from "../../../lib/ui/panel.ts";
import { type PiScreen, pinStdout, piScreen } from "./pi-screen.ts";

const ESCAPE = "\x1b";

/** A body of distinct, countable lines, longer than any screen here. */
function lines(count: number): string[] {
	return Array.from({ length: count }, (_, at) => `line ${at + 1}`);
}

/** Whether a numbered line is on screen, as itself rather than a prefix. */
function showsLine(screen: string, line: number): boolean {
	return new RegExp(`\\bline ${line}\\b`).test(screen);
}

describe("a panel on a screen the process's tty is not", () => {
	let s: PiScreen | undefined;
	let unpin: (() => void) | undefined;

	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		s?.stop();
		unpin?.();
	});

	/** pi's terminal at one size, the process's stdout at another. */
	function screens(
		screen: { columns: number; rows: number },
		stdout: { columns: number; rows: number },
	): PiScreen {
		unpin = pinStdout(stdout.columns, stdout.rows);
		s = piScreen(screen.columns, screen.rows);
		return s;
	}

	it("keeps its footer on a screen shorter than the tty", async () => {
		const on = screens({ columns: 100, rows: 15 }, { columns: 100, rows: 50 });
		const shown = view(on.ctx(), { content: () => lines(200) });

		const screen = await on.settled();
		expect(screen, "the way out is on the screen").toContain("close");
		expect(showsLine(screen, 1), "the body starts at its top").toBe(true);

		on.terminal.press(ESCAPE);
		await shown;
	});

	it("grows into a screen taller than the tty", async () => {
		const on = screens({ columns: 100, rows: 50 }, { columns: 100, rows: 15 });
		const shown = view(on.ctx(), { content: () => lines(200) });

		// Six tenths of 50 rows, less the view's five rows of chrome.
		const screen = await on.settled();
		expect(showsLine(screen, 25), "it fills its share of 50 rows").toBe(true);
		expect(showsLine(screen, 26), "and no more than its share").toBe(false);

		on.terminal.press(ESCAPE);
		await shown;
	});

	it("wraps prose at the screen's width while it can pan", async () => {
		const on = screens({ columns: 60, rows: 30 }, { columns: 200, rows: 30 });
		const words = `${"word ".repeat(40)}LASTWORD`;
		const shown = view(on.ctx(), {
			allowHScroll: true,
			content: (theme, width) => renderMarkdown(words, theme, width),
		});

		const screen = await on.settled();
		expect(screen, "the prose's last word is in view").toContain("LASTWORD");

		on.terminal.press(ESCAPE);
		await shown;
	});
});
