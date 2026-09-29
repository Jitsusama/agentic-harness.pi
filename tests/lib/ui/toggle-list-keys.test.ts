/**
 * The toggle list's keys do what its footer says.
 *
 * The footer read "Esc cancel" while Escape returned every row as the
 * person had left it, and the one caller saves whatever comes back, so
 * backing out of a settings panel applied the changes it was meant to
 * throw away. It also disagreed with the panel's own stopped answer,
 * which is the values it opened with. Now it keeps the library's model:
 * Enter acts on the row, Ctrl+Enter or Ctrl+S submits, Escape cancels.
 */

import { setKittyProtocolActive } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeEveryPanel } from "../../../lib/ui/panel-registry.ts";
import {
	promptToggleList,
	type ToggleListConfig,
} from "../../../lib/ui/prompt-toggle-list.ts";
import { type PiScreen, pinStdout, piScreen } from "./pi-screen.ts";

const COLUMNS = 120;
const ROWS = 30;
const ESCAPE = "\x1b";
const ENTER = "\r";
/** Ctrl+Enter as the kitty protocol sends it. */
const CTRL_ENTER = "\x1b[13;5u";
/** Ctrl+S, as any terminal sends it. */
const CTRL_S = "\x13";

const config = (): ToggleListConfig => ({
	title: "SETTINGS",
	sections: [
		{
			title: "tools",
			rows: [
				{
					id: "slack_post",
					label: "slack_post",
					options: ["direct", "progressive", "disabled"],
					index: 0,
				},
				{
					id: "slack_read",
					label: "slack_read",
					options: ["direct", "progressive", "disabled"],
					index: 0,
				},
			],
		},
	],
});

/** A promise's answer, or "still waiting" if it has none soon. */
function answersSoon<T>(answer: Promise<T>): Promise<T | string> {
	return Promise.race([
		answer,
		new Promise<string>((resolve) =>
			setTimeout(() => resolve("still waiting"), 200),
		),
	]);
}

const OPENED = { slack_post: "direct", slack_read: "direct" };
const CYCLED = { slack_post: "progressive", slack_read: "direct" };

describe("the toggle list's keys", () => {
	let s: PiScreen;
	let unpin: () => void;

	beforeEach(() => {
		unpin = pinStdout(COLUMNS, ROWS);
		s = piScreen(COLUMNS, ROWS);
	});

	afterEach(() => {
		// A failing case must not leave its panel holding the shared queue.
		closeEveryPanel();
		s.stop();
		unpin();
	});

	it("submits the rows as they stand on Ctrl+Enter", async () => {
		const answer = promptToggleList(s.ctx(), config());
		await s.settled();
		s.terminal.press(ENTER);
		await s.settled();
		s.terminal.press(CTRL_ENTER);
		expect(await answersSoon(answer)).toEqual(CYCLED);
		expect(await s.settled()).not.toContain("SETTINGS");
	});

	it("cancels on Escape, handing back what it opened with", async () => {
		const answer = promptToggleList(s.ctx(), config());
		await s.settled();
		s.terminal.press(ENTER);
		expect(await s.settled()).toContain("progressive");
		s.terminal.press(ESCAPE);
		expect(await answer).toEqual(OPENED);
		expect(await s.settled()).not.toContain("SETTINGS");
	});

	it("clears a filter on the first Escape and cancels on the second", async () => {
		const answer = promptToggleList(s.ctx(), config());
		await s.settled();
		s.terminal.press(ENTER);
		for (const key of "read") s.terminal.press(key);
		expect(await s.settled()).toContain("filter: read");
		s.terminal.press(ESCAPE);
		const cleared = await s.settled();
		expect(cleared).toContain("SETTINGS");
		expect(cleared).not.toContain("filter: read");
		s.terminal.press(ESCAPE);
		expect(await answer).toEqual(OPENED);
	});

	it("submits on Ctrl+S, which every terminal can send", async () => {
		const answer = promptToggleList(s.ctx(), config());
		await s.settled();
		s.terminal.press(ENTER);
		await s.settled();
		s.terminal.press(CTRL_S);
		expect(await answersSoon(answer)).toEqual(CYCLED);
	});

	it("says in its footer how to submit and that Escape cancels", async () => {
		const answer = promptToggleList(s.ctx(), config());
		const screen = await s.settled();
		expect(screen).toContain("Enter cycle");
		// No kitty protocol here, so nothing says Ctrl+Enter can be told
		// from Enter.
		expect(screen).toContain("Ctrl+S submit");
		expect(screen).toContain("Esc cancel");
		s.terminal.press(ESCAPE);
		await answer;
	});

	it("names Ctrl+Enter in its footer once the kitty protocol is on", async () => {
		setKittyProtocolActive(true);
		try {
			const answer = promptToggleList(s.ctx(), config());
			expect(await s.settled()).toContain("Ctrl+Enter submit");
			s.terminal.press(ESCAPE);
			await answer;
		} finally {
			setKittyProtocolActive(false);
		}
	});
});
