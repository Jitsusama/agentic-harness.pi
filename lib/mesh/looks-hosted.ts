/**
 * Asking whichever host holds a change about the person's looks at it,
 * for the changes GitHub's own ask (looks-github.ts) can't name.
 *
 * On 11 November, 135 of the looks' pull requests were on a host other
 * than github.com, and 75 of the 116 looks cleared by hand that evening
 * had merged days before: nothing asked their host, so each waited until
 * Joel found it. Joel, 20:26: "if it is no longer applicable because i
 * took too long and things have changed, it should disappear."
 *
 * A host is asked one change at a time, through the review provider that
 * claims the look's URL, so a turn asks a few looks and the next turn the
 * next few: every waiting look is asked within a few turns, and a turn
 * costs at most {@link MOST_ASKED_ELSEWHERE} calls.
 */

import type { Look, LookResolution } from "./looks.ts";
import { pullOf, type Resolved } from "./looks-github.ts";

/** The most looks one turn asks their hosts about. */
export const MOST_ASKED_ELSEWHERE = 10;

/** Where a change stands on its host. */
export type HostedState = "open" | "merged" | "closed";

/**
 * A change's state, read from the host whose provider claims its URL;
 * none when nothing claims it. It may reject, as a host can be down.
 */
export type StateOf = (change: string) => Promise<HostedState | undefined>;

/** Whether a look points at a change on a host GitHub's ask doesn't reach. */
function hostedElsewhere(look: Look): boolean {
	return (
		look.state === "waiting" &&
		(look.kind === "pr" || look.kind === "diff") &&
		/^https?:\/\//.test(look.target.trim()) &&
		!pullOf(look.target)
	);
}

/**
 * The waiting looks to ask their hosts about on this turn: at most
 * {@link MOST_ASKED_ELSEWHERE}, starting where the turn before left off,
 * so each is asked in its turn however many wait.
 */
export function askableElsewhere(looks: readonly Look[], turn: number): Look[] {
	const waiting = looks.filter(hostedElsewhere);
	if (waiting.length <= MOST_ASKED_ELSEWHERE) return waiting;
	const from = (turn * MOST_ASKED_ELSEWHERE) % waiting.length;
	return [...waiting.slice(from), ...waiting.slice(0, from)].slice(
		0,
		MOST_ASKED_ELSEWHERE,
	);
}

/** The change a look's URL names, without the place on its page it points at. */
export function changeOf(target: string): string {
	return target.trim().replace(/#.*$/, "");
}

/** How a change's state resolves a look at it, or none while it's open. */
function resolutionOf(
	state: HostedState | undefined,
): LookResolution | undefined {
	return state === "merged" || state === "closed" ? state : undefined;
}

/**
 * How each asked look resolved, its host asked about each change at
 * once: merged or closed. One the host can't answer for, or still open,
 * resolves nothing and is asked again in a later turn.
 */
export async function resolutionsElsewhere(
	asked: readonly Look[],
	stateOf: StateOf,
): Promise<Resolved[]> {
	const answers = await Promise.allSettled(
		asked.map((look) => stateOf(changeOf(look.target))),
	);
	return asked.flatMap((look, at): Resolved[] => {
		const answer = answers[at];
		if (answer?.status !== "fulfilled") return [];
		const how = resolutionOf(answer.value);
		return how ? [{ id: look.id, how }] : [];
	});
}
