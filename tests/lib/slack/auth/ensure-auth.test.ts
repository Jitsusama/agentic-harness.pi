/**
 * Closing Slack's authorization panel stops the OAuth login.
 *
 * The panel was shown and never listened to: Escape took it down and
 * left the callback server holding its port for five minutes, with the
 * tool that asked waiting on it and nothing on screen to say so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PiScreen, pinStdout, piScreen } from "../../ui/pi-screen.ts";

const handed: { callback?: AbortSignal } = {};

vi.mock("../../../../lib/slack/auth/setup-wizard.ts", () => ({
	ensureSetup: async () => ({
		mode: "oauth",
		app: { clientId: "id", clientSecret: "secret" },
	}),
}));

// Never the real credential store: a test must not sign anybody out.
vi.mock("@jitsusama/agentic-harness.core/slack", async (original) => ({
	...(await original<object>()),
	hasToken: () => false,
	getToken: () => undefined,
	storeToken: () => undefined,
}));

vi.mock("@jitsusama/agentic-harness.core/slack/auth/browser", () => ({
	openInBrowser: () => undefined,
}));

vi.mock("@jitsusama/agentic-harness.core/slack/auth/server", () => ({
	waitForOAuthCallback: (_port: number, options?: { signal?: AbortSignal }) => {
		handed.callback = options?.signal;
		return new Promise((_, reject) => {
			options?.signal?.addEventListener(
				"abort",
				() => reject(new DOMException("stopped", "AbortError")),
				{ once: true },
			);
		});
	},
}));

const { ensureAuthenticated } = await import(
	"../../../../lib/slack/auth/ensure-auth.ts"
);

const ESCAPE = "\x1b";
const STILL_RUNNING_MS = 1000;

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

describe("Slack's authorization panel", () => {
	let s: PiScreen;
	let unpin: () => void;

	beforeEach(() => {
		unpin = pinStdout(100, 24);
		s = piScreen(100, 24);
		handed.callback = undefined;
	});

	afterEach(() => {
		s.stop();
		unpin();
	});

	it("frees the callback port when Escape closes it", async () => {
		const ctx = s.ctx();
		const run = ensureAuthenticated(ctx, { clientId: "", clientSecret: "" });
		expect(await s.settled()).toContain("Slack Authorization");

		s.terminal.press(ESCAPE);

		expect(await outcome(run)).toMatchObject({
			message: "Slack authorization was cancelled.",
		});
		expect(handed.callback?.aborted).toBe(true);
		expect(await s.settled()).not.toContain("Slack Authorization");
	});
});
