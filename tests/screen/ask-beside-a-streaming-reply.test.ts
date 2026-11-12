/**
 * An ask raised while the model's reply streams in below it, in real pi.
 *
 * Joel, 11 November: "text from ask dialogs disappeearing as text comes
 * in". gate-beside-output.test.ts holds the case of a sibling tool's
 * output; this is the other way text comes in while an ask is up: an
 * extension raises it, as the mesh does for a question put to the
 * session, while the reply is still streaming. Every line of the ask
 * stays on screen in every frame, and nothing redraws the whole screen.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import panelLifecycle from "../../extensions/panel-lifecycle-workflow/index.ts";
import { showSinglePrompt } from "../../lib/ui/prompt-single.ts";
import { bootPi, type PiSession, sleep, waitFor } from "./pi-session.ts";

vi.setConfig({ testTimeout: 30_000 });

const COLS = 100;
/** Terminal heights: a roomy one, and one where ask and reply can't both fit whole. */
const HEIGHTS = [30, 20];

/** Lines in the reply, more than the terminal holds. */
const REPLY_LINES = 60;

/** Slow enough that the reply takes a few seconds, a frame a token or two. */
const TOKENS_PER_SECOND = 200;

/** How often the screen is read while the reply streams. */
const LOOK_MS = 10;

/** Fewer looks than this means the reply was done before the ask was up. */
const MOST_LOOKS_MISSED = 20;

/** The ask's body, four rows each naming itself. */
const ASK_ROWS = 4;

let pi: PiSession | undefined;
/** Whether the reply has finished streaming. */
let replied = false;
/** Whether the ask is up. */
let asked = false;

/** Raises an ask at the reply's first token, as a question put to the session would. */
function askMidReply(api: ExtensionAPI): void {
	api.on("message_update", (_event, ctx) => {
		if (asked) return;
		asked = true;
		void showSinglePrompt(ctx, {
			title: "MARK-title Approve the thing?",
			content: (_theme: unknown, width: number) =>
				Array.from({ length: ASK_ROWS }, (_, i) =>
					`MARK-ask-${i} ${"lorem ipsum ".repeat(6)}`.slice(0, width),
				),
			actions: [{ key: "r", label: "Reject" }],
		});
	});
	api.on("message_end", (event) => {
		if (event.message.role === "assistant") replied = true;
	});
}

/** The ask's rows that aren't on screen now. */
async function askRowsGone(session: PiSession): Promise<number[]> {
	const gone: number[] = [];
	for (let i = 0; i < ASK_ROWS; i++) {
		if (!(await session.onScreen(`MARK-ask-${i}`))) gone.push(i);
	}
	return gone;
}

beforeEach(() => {
	replied = false;
	asked = false;
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	await pi?.stop();
	pi = undefined;
	vi.restoreAllMocks();
});

describe("an ask raised while the reply streams in", () => {
	it.each(HEIGHTS)(
		"keeps every line of the ask on screen as the reply grows, %i rows",
		async (rows) => {
			const session = await bootPi({
				cols: COLS,
				rows,
				extensions: [askMidReply, panelLifecycle],
				tokensPerSecond: TOKENS_PER_SECOND,
			});
			pi = session;
			const reply = Array.from(
				{ length: REPLY_LINES },
				(_, i) => `MARK-reply-${i} and some words after it`,
			).join("\n");
			session.answer(reply);
			session.mark("streaming");
			await session.prompt("say a lot");
			await waitFor(() => session.onScreen("MARK-ask-3"), "the ask's body");

			const lost: string[] = [];
			let looks = 0;
			while (!replied) {
				looks += 1;
				const gone = await askRowsGone(session);
				if (gone.length > 0) lost.push(gone.join(","));
				// Several looks a token, so no frame goes unread.
				await sleep(LOOK_MS);
			}
			// A few frames past the last token, when the dock has dealt its room.
			await sleep(100);
			const after = await askRowsGone(session);
			if (after.length > 0) lost.push(after.join(","));

			expect(
				looks,
				"looks at the screen while the reply still streamed under the ask",
			).toBeGreaterThan(MOST_LOOKS_MISSED);
			expect(
				await session.inBuffer(`MARK-reply-${REPLY_LINES - 1}`),
				"the reply's last line, drawn",
			).toBeGreaterThan(0);
			expect(
				lost,
				"the ask's rows missing from the screen, a look at a time",
			).toEqual([]);
			const verdict = await session.verdict();
			expect(verdict.desync, "frames that drew other than pi meant").toEqual(
				[],
			);
			expect(
				verdict.redrawsAt,
				"whole-screen redraws while the reply streamed",
			).toEqual([]);
		},
	);
});
