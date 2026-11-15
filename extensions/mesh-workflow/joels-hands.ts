/**
 * Whether a question to the orchestrator that asks for the person's
 * hands says how many acts it asks of him against the fewest that would
 * do the job.
 *
 * On 14 November a session asked for a sitting that spread one password
 * over an item made by hand, a release, a 1Password approval and a key's
 * touch, where one paste did the job, and the person asked why he had to
 * approve everything. Each step had read as one approval on its own;
 * what was missing was counting the whole of it before asking. So a
 * question to the orchestrator that asks for his touch, paste, sign-in,
 * unlock or a sitting carries a line, "his acts: N; the fewest: M", and
 * a reason on that line when N is more than M. The words are matched
 * loosely, so a question that asks nothing of his hands but reads as if
 * it might says "his acts: 0; the fewest: 0" and goes.
 */

/** The person, however a question names him. */
const HIM = /\b(joel|the person|you|he|his|him)\b/i;

/** What his hands would do, as a question asks it. */
const HANDS =
	/\b(touch(es|ed|ing)?|tap(s|ped)?|paste[sd]?|(un)?plug(s|ged)?( it)? in|sign(s|ed)? in|log(s|ged)? in|unlock(s|ed)?|enrol(l|ls|led|s)?|types? (his|the|a) (password|passphrase|pin)|his hands|at the screen|at his desk|make (an|the) item)\b/i;

/** A sitting is his time and hands, whoever the sentence names. */
const SITTING = /\bsittings?\b/i;

/** The line counting his acts, and what follows on it. */
const COUNTED = /his acts:\s*(\d+)\s*;\s*the fewest:\s*(\d+)(.*)$/im;

/** How many words after the count make a reason for more acts. */
const REASON_WORDS = 3;

/** The first sentence that asks for his hands, if any does. */
function asksHands(text: string): string | undefined {
	return text
		.split(/(?<=[.?!])\s+|\n+/)
		.map((one) => one.trim())
		.find((one) => SITTING.test(one) || (HIM.test(one) && HANDS.test(one)));
}

/**
 * Why a question to the orchestrator can't go as written, when it asks
 * for the person's hands without counting his acts, or counts more than
 * the fewest without saying why; undefined when it may go.
 */
export function handsRefusal(text: string): string | undefined {
	const asking = asksHands(text);
	if (asking === undefined) return undefined;
	const counted = COUNTED.exec(text);
	if (!counted) {
		return `this asks for the person's hands ("${asking}") without a line saying "his acts: N; the fewest: M". Count every act it asks of him end to end (items to make, pastes, releases, approvals, touches, sign-ins, sittings) against the fewest that would do the job, add the line, and say on it why when N is more than M. If it asks nothing of his hands, add "his acts: 0; the fewest: 0".`;
	}
	const acts = Number(counted[1]);
	const fewest = Number(counted[2]);
	const reason = (counted[3] ?? "")
		.replace(/^[\s.,;:-]+/, "")
		.split(/\s+/)
		.filter(Boolean);
	if (acts > fewest && reason.length < REASON_WORDS) {
		return `this asks the person for ${acts} acts where ${fewest} would do, and its count line says nothing of why. Cut the asks to the fewest, or say on that line why each one more is needed.`;
	}
	return undefined;
}
