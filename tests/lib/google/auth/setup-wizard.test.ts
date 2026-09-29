/**
 * Google's setup wizard holds the screen for its whole run.
 *
 * It is a panel and then two of pi's own text dialogs, and between them
 * nothing held the screen, so another tool's gate could mount over the
 * dialog asking for a client secret.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promptSingle } from "../../../../lib/ui/panel.ts";
import { type PiScreen, pinStdout, piScreen } from "../../ui/pi-screen.ts";

const stored: unknown[] = [];

// Never the real credential store: a test must not sign anybody out.
vi.mock("@jitsusama/agentic-harness.core/google", async (original) => ({
	...(await original<object>()),
	hasOAuthApp: () => false,
	getOAuthApp: () => undefined,
	storeOAuthApp: (app: unknown) => stored.push(app),
}));

const { ensureOAuthApp } = await import(
	"../../../../lib/google/auth/setup-wizard.ts"
);

const ENTER = "\r";
const ESCAPE = "\x1b";
const NO_ENV = { clientId: "", clientSecret: "" };
const CLIENT_ID = "1234-abcd.apps.googleusercontent.com";

/** Pi's text dialog, answered when the test says. */
function dialog() {
	const asked: string[] = [];
	let answer: (text: string | undefined) => void = () => {};
	const editor = (title: string) => {
		asked.push(title);
		return new Promise<string | undefined>((resolve) => {
			answer = resolve;
		});
	};
	return { asked, editor, answer: (text?: string) => answer(text) };
}

describe("Google's setup wizard", () => {
	let s: PiScreen;
	let unpin: () => void;
	// Takes down whatever a failed test left up, which would otherwise hold
	// the screen, a process-wide queue, against the tests after it.
	let leftovers: AbortController;

	beforeEach(() => {
		leftovers = new AbortController();
		unpin = pinStdout(120, 40);
		s = piScreen(120, 40);
		stored.length = 0;
	});

	afterEach(() => {
		leftovers.abort();
		s.stop();
		unpin();
	});

	it("keeps the screen from its first step to its last", async () => {
		const entry = dialog();
		const base = s.ctx();
		const ctx = {
			...base,
			ui: { ...base.ui, editor: entry.editor, notify: () => undefined },
		} as unknown as ExtensionContext;
		const wizard = ensureOAuthApp(ctx, NO_ENV);
		expect(await s.settled()).toContain("Google Workspace Setup");
		s.terminal.press(ENTER);
		await s.settled();
		expect(entry.asked).toHaveLength(1);

		const other = promptSingle(s.ctx(leftovers.signal), {
			content: () => ["ANOTHER TOOL'S GATE"],
			actions: [{ key: "r", label: "Reject" }],
		});
		entry.answer(CLIENT_ID);
		await s.settled();
		expect(entry.asked).toHaveLength(2);
		expect(await s.settled()).not.toContain("ANOTHER TOOL'S GATE");

		entry.answer("the-secret");

		expect(await wizard).toEqual({
			clientId: CLIENT_ID,
			clientSecret: "the-secret",
		});
		expect(await s.settled()).toContain("ANOTHER TOOL'S GATE");
		s.terminal.press(ESCAPE);
		await other;
	});
});
