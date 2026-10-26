/**
 * Closing a Google login's waiting panel stops the login.
 *
 * Both flows showed a panel and never listened to it: Escape took it
 * down and left the device poll running for the code's whole life, or
 * the callback server holding its port with nothing on screen, and the
 * tool that asked waiting on it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_MESSAGES } from "../../../../lib/core/google/index.ts";
import { until } from "../../../support/until.ts";
import { type PiScreen, pinStdout, piScreen } from "../../ui/pi-screen.ts";

/** What each mocked wait was handed, so a test can see it stop. */
const handed: { poll?: AbortSignal; callback?: AbortSignal } = {};
const device = { fails: false };

vi.mock("../../../../lib/core/google/auth/browser.ts", () => ({
	openInBrowser: () => undefined,
}));

vi.mock("../../../../lib/core/google/auth/oauth.ts", async (original) => ({
	...(await original<object>()),
	initiateDeviceFlow: async () => {
		if (device.fails) throw new Error("invalid_client");
		return {
			device_code: "DEVICE",
			user_code: "ABCD-EFGH",
			verification_url: "https://www.google.com/device",
			interval: 5,
		};
	},
	pollForDeviceAuthorization: (
		_config: unknown,
		_code: string,
		_interval: number,
		signal?: AbortSignal,
	) => {
		handed.poll = signal;
		return untilStopped(signal);
	},
}));

vi.mock("../../../../lib/core/google/auth/server.ts", () => ({
	waitForOAuthCallback: (_port: number, options?: { signal?: AbortSignal }) => {
		handed.callback = options?.signal;
		return untilStopped(options?.signal);
	},
}));

const { authenticateWithFallback } = await import(
	"../../../../lib/google/auth/dual-flow.ts"
);

const ESCAPE = "\x1b";
// How long a run may take to come to something before it counts as
// still going. A stopped login settles in milliseconds, but Escape first
// waits out the terminal's pause for a key sequence, and on a loaded
// machine a one-second bound failed runs that were stopping correctly.
// A login that never stops fails here either way, only later.
const STILL_RUNNING_MS = 5_000;
const CONFIG = { clientId: "id", clientSecret: "secret" };

/** A wait that lasts until its signal fires, as the real ones do. */
function untilStopped(signal: AbortSignal | undefined): Promise<never> {
	return new Promise((_, reject) => {
		signal?.addEventListener(
			"abort",
			() => reject(new DOMException("stopped", "AbortError")),
			{ once: true },
		);
	});
}

/**
 * Wait for the screen to show `text`, or to stop showing it. A panel
 * opens after the login's own awaits (the web flow only once the device
 * flow has failed), so one settled frame can land in the gap.
 */
async function screenShows(
	s: PiScreen,
	text: string,
	shown = true,
): Promise<void> {
	await until(
		`the screen ${shown ? "shows" : "drops"} ${text}`,
		async () => (await s.settled()).includes(text) === shown,
	);
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

describe("a Google login's waiting panel", () => {
	let s: PiScreen;
	let unpin: () => void;

	beforeEach(() => {
		unpin = pinStdout(100, 24);
		s = piScreen(100, 24);
		handed.poll = undefined;
		handed.callback = undefined;
		device.fails = false;
	});

	afterEach(() => {
		s.stop();
		unpin();
	});

	it("stops the device poll when Escape closes it", async () => {
		const run = authenticateWithFallback(CONFIG, s.ctx());
		await screenShows(s, "ABCD-EFGH");

		s.terminal.press(ESCAPE);

		expect(await outcome(run)).toMatchObject({
			message: AUTH_MESSAGES.cancelled,
		});
		expect(handed.poll?.aborted).toBe(true);
		await screenShows(s, "ABCD-EFGH", false);
	});

	it("stops the device poll when its caller's signal fires", async () => {
		const turn = new AbortController();
		const run = authenticateWithFallback(CONFIG, s.ctx(), turn.signal);
		await screenShows(s, "ABCD-EFGH");

		turn.abort();

		expect(await outcome(run)).toMatchObject({
			message: AUTH_MESSAGES.cancelled,
		});
		await screenShows(s, "ABCD-EFGH", false);
	});

	it("frees the callback port when Escape closes the web flow's panel", async () => {
		device.fails = true;
		const run = authenticateWithFallback(CONFIG, s.ctx());
		await screenShows(s, "Web Flow Authentication");

		s.terminal.press(ESCAPE);

		expect(await outcome(run)).toMatchObject({
			message: AUTH_MESSAGES.cancelled,
		});
		expect(handed.callback?.aborted).toBe(true);
		await screenShows(s, "Web Flow Authentication", false);
	});
});
