/**
 * A Slack or review gate still waiting for the screen leaves when its
 * turn is stopped or its session ends, and never mounts afterwards.
 *
 * The panels queue at the mount, which withdraws a waiting panel on
 * either. These gates also wrapped the panel in a queue slot of their
 * own, taken before the panel was asked for and with no signal, so a
 * gate waiting there was out of the mount's reach: it stayed queued past
 * its turn and its session and mounted once the screen came free.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confirmWrite } from "../../extensions/review-integration/gate.ts";
import { confirmSendMessage } from "../../extensions/slack-integration/confirmation.ts";
import { closeEveryPanel } from "../../lib/ui/panel-registry.ts";
import { type PiScreen, pinStdout, piScreen } from "../lib/ui/pi-screen.ts";

const COLUMNS = 120;
const ROWS = 30;
const ESCAPE = "\x1b";
const PATIENCE_MS = 200;

/** Each family's gate, raised with the given context. */
const families = [
	{
		name: "slack",
		raise: (s: PiScreen, body: string, signal?: AbortSignal) =>
			confirmSendMessage(s.ctx(signal), "#general", body),
	},
	{
		name: "review",
		raise: (s: PiScreen, body: string, signal?: AbortSignal) =>
			confirmWrite(s.ctx(signal), "Post a comment", body),
	},
];

/** Whether a promise settles within the patience window. */
function answersSoon(answer: Promise<unknown>): Promise<boolean> {
	return Promise.race([
		answer.then(() => true),
		new Promise<boolean>((resolve) =>
			setTimeout(() => resolve(false), PATIENCE_MS),
		),
	]);
}

describe.each(families)("a $name gate waiting its turn", ({ raise }) => {
	let s: PiScreen;
	let unpin: () => void;

	beforeEach(() => {
		unpin = pinStdout(COLUMNS, ROWS);
		s = piScreen(COLUMNS, ROWS);
	});

	afterEach(() => {
		closeEveryPanel();
		s.stop();
		unpin();
	});

	it("leaves at once when its turn is stopped", async () => {
		const first = raise(s, "FIRST BODY");
		expect(await s.settled()).toContain("FIRST BODY");
		const turn = new AbortController();
		const second = raise(s, "SECOND BODY", turn.signal);
		await s.settled();

		turn.abort();
		expect(await answersSoon(second)).toBe(true);

		s.terminal.press(ESCAPE);
		await first;
		expect(await s.settled()).not.toContain("SECOND BODY");
		expect(s.tui.hasOverlayEntries).toBe(false);
	});

	it("never mounts once its session has ended", async () => {
		const first = raise(s, "FIRST BODY");
		expect(await s.settled()).toContain("FIRST BODY");
		const second = raise(s, "SECOND BODY");
		await s.settled();

		expect(closeEveryPanel()).toBe(2);
		await first;
		expect(await answersSoon(second)).toBe(true);
		expect(await s.settled()).not.toContain("SECOND BODY");
		expect(s.tui.hasOverlayEntries).toBe(false);
	});
});
