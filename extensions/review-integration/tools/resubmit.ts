/**
 * Saying so when a refused description comes back unchanged.
 *
 * A description that breaks the PR format is refused with every point
 * to fix, and a tool call cannot loop, so nothing is lost by refusing
 * it again. But the logs show agents sending the same words back, 15
 * times in 257 refusals, and getting the same list with nothing to say
 * they had changed nothing. A refusal that reads like the first one
 * reads like a fresh problem. Saying it is the same text, refused a
 * moment ago, tells the agent the list is still waiting to be read.
 */

import { createHash } from "node:crypto";

/** How many refused descriptions are remembered, newest kept. */
const REMEMBERED = 32;

/** When each refused description was refused, by its digest. */
const refused = new Map<string, number>();

/**
 * The complaint as it should be said: with a note in front when this
 * exact title and body were refused before in this session.
 */
export function sayRefusal(
	complaint: string,
	title: string | undefined,
	body: string | undefined,
	now: number = Date.now(),
): string {
	const key = createHash("sha1")
		.update(`${title ?? ""}\0${body ?? ""}`)
		.digest("hex");
	const before = refused.get(key);
	refused.delete(key);
	refused.set(key, now);
	if (refused.size > REMEMBERED) {
		const oldest = refused.keys().next().value;
		if (oldest !== undefined) refused.delete(oldest);
	}
	if (before === undefined) return complaint;
	return `${unchanged(now - before)}\n\n${complaint}`;
}

/** Forget every refusal; for tests. */
export function forgetRefusals(): void {
	refused.clear();
}

function unchanged(elapsedMs: number): string {
	const minutes = Math.round(elapsedMs / 60_000);
	const when =
		minutes < 1
			? "less than a minute ago"
			: minutes === 1
				? "a minute ago"
				: `${minutes} minutes ago`;
	return `This is word for word the description refused ${when}, so every point below still stands. Change the text where each point says before sending it again.`;
}
