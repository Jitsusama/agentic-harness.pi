/**
 * What away mode says, in one place so the wording can be read whole.
 *
 * Everything here is said by the harness as itself, never in the
 * person's voice, and refers to them as "the user".
 */

import type { Return } from "../../lib/internal/away/state.ts";

/** What the model is told when an absence starts. */
export function awayNow(goal: string | undefined, already: boolean): string {
	return [
		already
			? "Away mode was already on."
			: "Away mode is on, for every session on this machine.",
		goal ? `Goal: ${goal}` : "",
		"Until the user is back, nothing waits on them: a blocking approval is held for their return instead of opening a panel (nothing is sent), and ask takes your recommendation.",
		"Keep working towards the goal. End a run only with a last line starting `Done:` when it is met, or `Blocked:` naming what needs the user when nothing within your reach is left; any other ending is sent back to you.",
		"Make reversible choices yourself and say what you chose. Do not look for a way round a held gate. The user ends away mode by typing.",
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * What the model is told once the person is back: what was held and
 * what was decided for them. Undefined when nothing waited.
 *
 * `elsewhere` is for a session that learns of the return because the
 * person typed in another window: they said nothing here, so there is
 * nothing of theirs to deal with first.
 */
export function returnMessage(
	back: Return,
	elsewhere = false,
): string | undefined {
	if (back.held.length === 0 && back.decided.length === 0) return undefined;
	const lines = [
		elsewhere
			? `The user is back at the machine (they typed in another window); away mode has ended here too (it began ${back.since}).`
			: `The user is back; away mode has ended (it began ${back.since}). Deal with what they said first.`,
	];
	if (back.held.length > 0) {
		lines.push(
			"",
			"Held while they were away, and not sent:",
			...back.held.map((call) => `- #${call.id} ${call.title} (${call.guard})`),
			"Nothing here is approved. If one is still wanted, make the call again and they will be asked in its own panel.",
		);
	}
	if (back.decided.length > 0) {
		lines.push(
			"",
			"Decided without them:",
			...back.decided.map(
				(d) =>
					`- ${d.question} → ${d.answer} (${d.by === "recommendation" ? "your recommendation" : "your call"})`,
			),
			"Tell them about any of these that they would want to revisit.",
		);
	}
	return lines.join("\n");
}

/**
 * Departures said in the first person and in the present, so a pasted
 * log saying "while I was sleeping" does not read as one.
 */
const DEPARTURES = [
	/\bi(?:'m| am)\s+(?:going|heading|off)\s+(?:to\s+)?(?:bed|sleep|out|offline|away|home)\b/i,
	/\b(?:going|heading|off)\s+to\s+(?:bed|sleep)\b/i,
	/\bi(?:'ll| will)\s+be\s+(?:away|out|gone|offline|afk|back)\b/i,
	/\bwhile\s+i(?:'m| am)\s+(?:away|out|gone|asleep|sleeping|offline)\b/i,
	/\b(?:work|keep\s+(?:going|working))\s+(?:unattended|overnight)\b/i,
	/\b(?:afk|brb)\b/i,
];

/** Whether a typed message reads like the person saying they are leaving. */
export function readsLikeDeparture(text: string): boolean {
	return DEPARTURES.some((pattern) => pattern.test(text));
}

/**
 * The hint added to a turn whose message reads like a departure. The
 * harness does not decide; the model reads the message in context.
 */
export const DEPARTURE_HINT =
	"Harness note: the user's message may say they are leaving. If they are saying so now, call away with their goal in their words before carrying on. If they are quoting, pasting or describing something, ignore this note.";
