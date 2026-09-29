/**
 * A panel shown while something runs, and closing it to stop that thing.
 *
 * The logins showed a waiting panel and never listened to it: Escape took
 * the panel down and left the login polling, the port held and the tool
 * waiting, with nothing left on screen to say so. The panel is the only
 * control a person has there, so closing it has to stop the work.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { viewWhile } from "../../../lib/ui/panel.ts";
import type { ViewConfig } from "../../../lib/ui/types.ts";
import { type PiScreen, pinStdout, piScreen } from "./pi-screen.ts";

const ESCAPE = "\x1b";

/** Long enough that work nothing stops is plainly still running. */
const STILL_RUNNING_MS = 1000;

const WAITING: ViewConfig = { content: () => ["WAITING FOR THE LOGIN"] };

/** Work that runs until it is stopped, and says why it stopped. */
function untilStopped(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}

/** What a run came to, or that it is still going. */
function outcome(run: Promise<unknown>): Promise<unknown> {
	return Promise.race([
		run.then(
			(value) => ({ value }),
			(error: unknown) => error,
		),
		new Promise((resolve) =>
			setTimeout(() => resolve("still running"), STILL_RUNNING_MS),
		),
	]);
}

describe("a panel shown while work runs", () => {
	let s: PiScreen;
	let unpin: () => void;

	beforeEach(() => {
		unpin = pinStdout(100, 24);
		s = piScreen(100, 24);
	});

	afterEach(() => {
		s.stop();
		unpin();
	});

	it("comes down when the work finishes, with the work's answer", async () => {
		let finish: (value: string) => void = () => {};
		const run = viewWhile(
			s.ctx(),
			WAITING,
			() =>
				new Promise<string>((resolve) => {
					finish = resolve;
				}),
		);
		expect(await s.settled()).toContain("WAITING FOR THE LOGIN");

		finish("signed in");

		expect(await outcome(run)).toEqual({ value: "signed in" });
		expect(await s.settled()).not.toContain("WAITING FOR THE LOGIN");
		expect(s.tui.hasOverlayEntries).toBe(false);
	});

	it("stops the work when Escape closes it", async () => {
		let handed: AbortSignal | undefined;
		const run = viewWhile(s.ctx(), WAITING, (signal) => {
			handed = signal;
			return untilStopped(signal);
		});
		expect(await s.settled()).toContain("WAITING FOR THE LOGIN");

		s.terminal.press(ESCAPE);

		expect(await outcome(run)).toMatchObject({ name: "AbortError" });
		expect(handed?.aborted).toBe(true);
		expect(await s.settled()).not.toContain("WAITING FOR THE LOGIN");
	});

	it("stops the work when the caller's own signal fires", async () => {
		const turn = new AbortController();
		const run = viewWhile(
			s.ctx(),
			{ ...WAITING, signal: turn.signal },
			untilStopped,
		);
		expect(await s.settled()).toContain("WAITING FOR THE LOGIN");

		turn.abort();

		expect(await outcome(run)).toMatchObject({ name: "AbortError" });
		expect(await s.settled()).not.toContain("WAITING FOR THE LOGIN");
	});

	it("never stops the work where there is no screen to close", async () => {
		// Headless, the panel returns at once without ever showing; that
		// is not a person closing it.
		const headless = { ...s.ctx(), hasUI: false } as ReturnType<
			PiScreen["ctx"]
		>;
		let finish: (value: string) => void = () => {};
		let handed: AbortSignal | undefined;
		const run = viewWhile(headless, WAITING, (signal) => {
			handed = signal;
			return new Promise<string>((resolve) => {
				finish = resolve;
			});
		});
		await s.settled();
		expect(handed?.aborted).toBe(false);

		finish("signed in");

		expect(await run).toBe("signed in");
	});
});
