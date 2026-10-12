/**
 * Applying the policy at the moment a guard fires.
 *
 * A redirect knows what it would refuse and why; whether it does is
 * the policy's call. This keeps that decision in one place so every
 * guard says the same thing in each mode.
 */

import { hold, isAway } from "../internal/away/state.ts";
import { guardMode } from "./policy.ts";
import { reportGuard } from "./report.ts";
import type { GuardianResult } from "./types.ts";

/**
 * A gate's verdict under the named guard's mode. A refusal is returned
 * as it is when the guard blocks, reported and dropped when it
 * reports, and dropped when it is off. Anything that is not a refusal
 * passes through untouched. The title names what was refused in the
 * report.
 */
export function refusalUnder<R extends GuardianResult>(
	guard: string,
	verdict: R,
	title: string,
): R | undefined {
	if (!verdict || !("block" in verdict)) return verdict;
	const mode = guardMode(guard);
	if (mode === "block") return verdict;
	if (mode === "report") {
		reportGuard({ guard, kind: "waved", title, body: verdict.reason });
	}
	return undefined;
}

/**
 * Whether an approval should ask a person. A blocking guard asks. A
 * reporting one puts what it would have shown in the transcript and
 * lets the action go; an off one lets it go silently. The body is a
 * thunk so a guard that will ask never pays to render it twice.
 */
export function asksUnder(
	guard: string,
	title: string,
	body?: () => string,
): boolean {
	const mode = guardMode(guard);
	if (mode === "block") return true;
	if (mode === "report") {
		const markdown = body?.();
		reportGuard({
			guard,
			kind: "shown",
			title,
			...(markdown ? { body: markdown } : {}),
		});
	}
	return false;
}

/**
 * What an approval gate should do.
 *
 * - ask: show the panel, as a blocking gate always did.
 * - go: approve without asking.
 * - held: the person is away, so refuse with the reason, which says
 *   the call is held for their return and what happens then.
 */
export type Approval =
	| { readonly kind: "ask" }
	| { readonly kind: "go" }
	| { readonly kind: "held"; readonly reason: string };

const ASK: Approval = { kind: "ask" };
const GO: Approval = { kind: "go" };

/**
 * What an approval gate should do under its guard's mode and the
 * person's presence. Off and report behave as `asksUnder` does. A
 * blocking guard asks when the person is here; while they are away it
 * holds the call instead, so nothing waits on them. Nothing is ever
 * approved on the strength of a hold: once the person is back, a call
 * made again asks like any other.
 *
 * The body is a thunk for the same reason as in `asksUnder`.
 */
export function approvalUnder(
	guard: string,
	title: string,
	body?: () => string,
): Approval {
	if (!asksUnder(guard, title, body)) return GO;
	if (!isAway()) return ASK;

	const markdown = body?.();
	const held = hold({
		guard,
		title,
		...(markdown !== undefined ? { body: markdown } : {}),
	});
	reportGuard({
		guard,
		kind: "held",
		title: `#${held.id} ${title}`,
		...(markdown ? { body: markdown } : {}),
	});
	return { kind: "held", reason: heldReason(held.id, guard, title) };
}

/** What the model is told when its call is held. */
function heldReason(id: number, guard: string, title: string): string {
	return [
		`Held as #${id} (${title}): the user is away, and the ${guard} guard needs them to approve this. Nothing was sent.`,
		"Carry on with work that does not depend on it, and do not try another way round the gate.",
		"When they are back they will see it listed; if it is still wanted then, make the call again and they will be asked.",
	].join(" ");
}

/** Plain text fenced as markdown, so a report shows it verbatim. */
export function fenced(text: string): string {
	return `\`\`\`text\n${text.trimEnd()}\n\`\`\``;
}
