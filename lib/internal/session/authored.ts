/**
 * Who wrote a change, asked over the bus: whether the account signed in
 * to its host wrote it. Every change an agent proposes is opened under
 * the person's own account, so a change that account wrote is one of his
 * sessions', whichever session put it up and whether or not any record
 * of the proposal survived (Joel, 24 November: "don't fucking put prs in
 * my look list"). The mesh asks before it puts a look up; the review
 * integration, which knows the hosts, answers. Neither imports the other.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../record.ts";

/** Asked on the bus, with a URL and somewhere to answer, before a look goes up. */
export const CHANGE_AUTHORED_ASK = "session:change-authored-ask:v1";

/** How long an answer is waited for: a host is asked twice, for the change and for who is signed in. */
export const AUTHORED_WAIT_MS = 20_000;

/** What a host says of the account that wrote a URL's change. */
export type Authored =
	/** The account signed in to its host wrote it, as `author`. */
	| { readonly by: "signed-in"; readonly author: string }
	/** Someone else wrote it. */
	| { readonly by: "other"; readonly author: string }
	/** No host claims the URL as a change. */
	| { readonly by: "no-change" }
	/** A host claims it but couldn't say who wrote it, and why. */
	| { readonly by: "unknown"; readonly why: string }
	/** Nothing answered in time: no review integration, or a host too slow. */
	| { readonly by: "unanswered" };

/** What an answerer is given: the URL, and a call to answer it once. */
interface AuthoredAsk {
	readonly url: string;
	readonly answer: (authored: Authored) => void;
}

/**
 * Ask on `bus` who wrote the change at `url`, waiting `waitMs` at most;
 * the first answer counts. Unanswered when nothing answers in time or
 * the bus can't be said on.
 */
export function askAuthored(
	bus: Pick<EventBus, "emit">,
	url: string,
	waitMs: number = AUTHORED_WAIT_MS,
): Promise<Authored> {
	return new Promise((settle) => {
		let settled = false;
		const once = (authored: Authored): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			settle(authored);
		};
		const timer = setTimeout(() => once({ by: "unanswered" }), waitMs);
		try {
			bus.emit(CHANGE_AUTHORED_ASK, { url, answer: once });
		} catch {
			// A bus nobody can say on, after a reload: nothing can answer.
			once({ by: "unanswered" });
		}
	});
}

/**
 * Answer every ask on `bus` with what `judge` says of its URL. A judge
 * that throws answers unknown, saying why. Returns a disposer.
 */
export function answerAuthored(
	bus: EventBus,
	judge: (url: string) => Promise<Authored>,
): () => void {
	return bus.on(CHANGE_AUTHORED_ASK, (data) => {
		if (!isAuthoredAsk(data)) return;
		judge(data.url).then(data.answer, (error: unknown) =>
			data.answer({
				by: "unknown",
				why: error instanceof Error ? error.message : String(error),
			}),
		);
	});
}

/** Whether `data` is an ask: a URL and a call to answer it. */
function isAuthoredAsk(data: unknown): data is AuthoredAsk {
	return (
		isRecord(data) &&
		typeof data.url === "string" &&
		typeof data.answer === "function"
	);
}
