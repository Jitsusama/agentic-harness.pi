/**
 * Google's sign-in holds the screen from its question to its last panel.
 *
 * Between answering "Authenticate now" and the device code appearing is a
 * request to Google, and nothing held the screen across it, so another
 * tool's gate could take the screen and the code panel queued behind it.
 */

import { AUTH_MESSAGES } from "@jitsusama/agentic-harness.core/google";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promptSingle } from "../../../../lib/ui/panel.ts";
import { type PiScreen, pinStdout, piScreen } from "../../ui/pi-screen.ts";

const deviceCode: { fetched: () => void } = { fetched: () => {} };

vi.mock("../../../../lib/google/auth/setup-wizard.ts", () => ({
	ensureOAuthApp: async () => ({ clientId: "id", clientSecret: "secret" }),
}));

// Never the real credential store: a test must not sign anybody out.
vi.mock("@jitsusama/agentic-harness.core/google", async (original) => ({
	...(await original<object>()),
	getCredentials: () => undefined,
	getDefaultAccount: () => undefined,
	storeCredentials: () => undefined,
	saveAccount: () => undefined,
	listAccounts: () => [],
}));

vi.mock("@jitsusama/agentic-harness.core/google/auth/browser", () => ({
	openInBrowser: () => undefined,
}));

vi.mock(
	"@jitsusama/agentic-harness.core/google/auth/oauth",
	async (original) => ({
		...(await original<object>()),
		initiateDeviceFlow: () =>
			new Promise((resolve) => {
				deviceCode.fetched = () =>
					resolve({
						device_code: "DEVICE",
						user_code: "ABCD-EFGH",
						verification_url: "https://www.google.com/device",
						interval: 5,
					});
			}),
		pollForDeviceAuthorization: (
			_config: unknown,
			_code: string,
			_interval: number,
			signal?: AbortSignal,
		) =>
			new Promise((_, reject) => {
				signal?.addEventListener(
					"abort",
					() => reject(new DOMException("stopped", "AbortError")),
					{ once: true },
				);
			}),
	}),
);

const { ensureAuthenticated } = await import(
	"../../../../lib/google/auth/ensure-auth.ts"
);

const ENTER = "\r";
const ESCAPE = "\x1b";

describe("Google's sign-in", () => {
	let s: PiScreen;
	let unpin: () => void;
	// Takes down whatever a failed test left up, which would otherwise hold
	// the screen, a process-wide queue, against the tests after it.
	let leftovers: AbortController;

	beforeEach(() => {
		leftovers = new AbortController();
		unpin = pinStdout(100, 24);
		s = piScreen(100, 24);
	});

	afterEach(() => {
		leftovers.abort();
		s.stop();
		unpin();
	});

	it("keeps the screen while the device code is fetched", async () => {
		const run = ensureAuthenticated(s.ctx(leftovers.signal), {
			clientId: "",
			clientSecret: "",
		});
		const failed = run.catch((error: unknown) => error);
		expect(await s.settled()).toContain("Authentication Required");
		s.terminal.press(ENTER);
		await s.settled();

		const other = promptSingle(s.ctx(leftovers.signal), {
			content: () => ["ANOTHER TOOL'S GATE"],
			actions: [{ key: "r", label: "Reject" }],
		});
		deviceCode.fetched();

		const screen = await s.settled();
		expect(screen).toContain("ABCD-EFGH");
		expect(screen).not.toContain("ANOTHER TOOL'S GATE");

		s.terminal.press(ESCAPE);
		expect(await failed).toMatchObject({ message: AUTH_MESSAGES.cancelled });
		expect(await s.settled()).toContain("ANOTHER TOOL'S GATE");
		s.terminal.press(ESCAPE);
		await other;
	});
});
