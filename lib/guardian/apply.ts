/**
 * Applying the policy at the moment a guard fires.
 *
 * A redirect knows what it would refuse and why; whether it does is
 * the policy's call. This keeps that decision in one place so every
 * guard says the same thing in each mode.
 */

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

/** Plain text fenced as markdown, so a report shows it verbatim. */
export function fenced(text: string): string {
	return `\`\`\`text\n${text.trimEnd()}\n\`\`\``;
}
