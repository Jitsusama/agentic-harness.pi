/**
 * Slack's setup wizard holds the screen for its whole run, and each of
 * its waits can be left.
 *
 * The wizard is several panels and pi's own text dialogs in turn. Between
 * them nothing held the screen, so another tool's gate could mount on top
 * of the dialog asking for a workspace URL. Escape on that dialog still
 * launched Chrome, and Escape on the extraction panel left it polling
 * for five minutes with nothing on screen.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promptSingle } from "../../../../lib/ui/panel.ts";
import { type PiScreen, pinStdout, piScreen } from "../../ui/pi-screen.ts";

const extraction: { calls: number; signal?: AbortSignal } = { calls: 0 };

// Never the real credential store: a test must not sign anybody out.
vi.mock("@jitsusama/agentic-harness.core/slack", async (original) => ({
	...(await original<object>()),
	hasToken: () => false,
	getToken: () => undefined,
	hasOAuthApp: () => false,
	getOAuthApp: () => undefined,
	storeToken: () => undefined,
	storeOAuthApp: () => undefined,
}));

vi.mock("@jitsusama/agentic-harness.core/slack/auth/browser-extract", () => ({
	extractFromBrowser: (
		_url?: string,
		_timeout?: number,
		_onStep?: unknown,
		options?: { signal?: AbortSignal },
	) => {
		extraction.calls += 1;
		extraction.signal = options?.signal;
		return new Promise((_, reject) => {
			options?.signal?.addEventListener(
				"abort",
				() => reject(new DOMException("stopped", "AbortError")),
				{ once: true },
			);
		});
	},
}));

const { ensureSetup } = await import(
	"../../../../lib/slack/auth/setup-wizard.ts"
);

const ENTER = "\r";
const ESCAPE = "\x1b";
const STILL_RUNNING_MS = 1000;
const NO_ENV = { clientId: "", clientSecret: "" };

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

describe("Slack's setup wizard", () => {
	let s: PiScreen;
	let unpin: () => void;
	let notes: string[];
	// Takes down whatever a failed test left up, which would otherwise hold
	// the screen, a process-wide queue, against the tests after it.
	let leftovers: AbortController;

	beforeEach(() => {
		leftovers = new AbortController();
		unpin = pinStdout(100, 30);
		s = piScreen(100, 30);
		extraction.calls = 0;
		extraction.signal = undefined;
		notes = [];
	});

	afterEach(() => {
		leftovers.abort();
		s.stop();
		unpin();
	});

	function withDialog(editor: ReturnType<typeof dialog>): ExtensionContext {
		const base = s.ctx();
		return {
			...base,
			ui: {
				...base.ui,
				editor: editor.editor,
				notify: (text: string) => notes.push(text),
			},
		} as unknown as ExtensionContext;
	}

	it("keeps the screen while pi's dialog asks for the workspace", async () => {
		const url = dialog();
		const ctx = withDialog(url);
		const wizard = ensureSetup(ctx, NO_ENV);
		expect(await s.settled()).toContain("Slack Integration Setup");
		s.terminal.press(ENTER);
		await s.settled();
		expect(url.asked).toHaveLength(1);

		const other = promptSingle(s.ctx(leftovers.signal), {
			content: () => ["ANOTHER TOOL'S GATE"],
			actions: [{ key: "r", label: "Reject" }],
		});
		expect(await s.settled()).not.toContain("ANOTHER TOOL'S GATE");

		url.answer(undefined);

		expect(await outcome(wizard)).toEqual({ value: null });
		expect(extraction.calls).toBe(0);
		expect(await s.settled()).toContain("ANOTHER TOOL'S GATE");
		s.terminal.press(ESCAPE);
		await other;
	});

	it("stops the extraction when Escape closes its panel", async () => {
		const url = dialog();
		const wizard = ensureSetup(withDialog(url), NO_ENV);
		await s.settled();
		s.terminal.press(ENTER);
		await s.settled();
		url.answer("team.slack.com");
		expect(await s.settled()).toContain("Browser Credential Extraction");

		s.terminal.press(ESCAPE);

		expect(await outcome(wizard)).toEqual({ value: null });
		expect(extraction.signal?.aborted).toBe(true);
		expect(notes.join("\n")).toContain("cancelled");
		expect(await s.settled()).not.toContain("Browser Credential Extraction");
	});
});
