/**
 * Waiting on an ask's answer: the daemon writes it beside the ask once
 * Joel answers or the ask runs out, so the folder is watched rather than
 * read again and again, and the wait ends on the answer, on the call's
 * stop, or at a deadline past which nobody is answering.
 */

import { type FSWatcher, watch } from "node:fs";
import { answerOf, type SecretAnswer } from "../../lib/internal/secret-ask.ts";

/** How a wait ended. */
export type Waited =
	| { readonly kind: "answered"; readonly answer: SecretAnswer }
	| { readonly kind: "stopped" }
	| { readonly kind: "unanswered" };

/**
 * The ask's answer once it's written, or why there's none: the signal
 * stopped the wait, or `withinMs` passed with nothing written.
 */
export function waitForAnswer(
	folder: string,
	id: string,
	signal: AbortSignal,
	withinMs: number,
): Promise<Waited> {
	return new Promise((resolve) => {
		let watcher: FSWatcher | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const end = (waited: Waited) => {
			watcher?.close();
			clearTimeout(timer);
			signal.removeEventListener("abort", stopped);
			resolve(waited);
		};
		const stopped = () => end({ kind: "stopped" });
		const look = () => {
			const answer = answerOf(folder, id);
			if (answer) end({ kind: "answered", answer });
		};
		if (signal.aborted) {
			end({ kind: "stopped" });
			return;
		}
		signal.addEventListener("abort", stopped, { once: true });
		// Waiting past this means the daemon isn't there to answer, so the
		// ask is taken back rather than left on Joel's screen. The timer is
		// the deadline, not a poll.
		timer = setTimeout(() => end({ kind: "unanswered" }), withinMs);
		watcher = watch(folder, (_event, name) => {
			if (name === `${id}.answer.json`) look();
		});
		// Written between the ask and the watch, it would be heard by neither.
		look();
	});
}
