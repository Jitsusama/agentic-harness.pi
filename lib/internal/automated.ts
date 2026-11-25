/**
 * The turns the harness starts itself.
 *
 * A turn started from idle has to go through pi's prompt path, which
 * makes it a user message: `sendMessage` with `triggerTurn` skips
 * `before_agent_start`, so that run would go out without the system
 * prompt the harness builds there. A user message reads, to the model,
 * to a person scrolling back and to anything reading the log, exactly
 * like something typed. So every such turn opens with one header,
 * built here and recognised here, and nothing else spells it.
 *
 * Messages said inside a run the harness did not start are custom
 * messages instead, and need none of this.
 */

/** How every automated turn opens, up to the reason it gives. */
const HEADER_OPENING = "[Automated message, no human input: ";

/**
 * Openings the harness used before the header, so a log written then
 * reads the same way now. The cost ledger reaches back months.
 */
const LEGACY_OPENINGS = [
	"The context was compacted to keep this session affordable.",
	"Compacting the context failed, so it was left as it is.",
	"Verification found ",
	// A machine's steer, before it carried the header.
	"[Said by this machine's ",
];

/**
 * The header for an automated turn, saying why it was sent: "background
 * jobs are reporting", "the context was compacted".
 */
export function automatedHeader(reason: string): string {
	return `${HEADER_OPENING}${reason}.]`;
}

/** An automated turn: the header, then what it says. */
export function automatedText(reason: string, body: string): string {
	return `${automatedHeader(reason)} ${body}`;
}

/**
 * Why a session's first words are marked when its start, not a person,
 * left them: a sprout's ask, which the session works from.
 */
export const START_WORDS_REASON = "this session's start left it these words";

/**
 * The words a session's start left it, without their header, or nothing
 * when `text` isn't those. Unlike the harness's other turns, they hold
 * what the session was asked to do, so a reader that drops automated
 * turns as no one's words can still keep these as the start's.
 */
export function startWordsOf(text: string): string | undefined {
	const header = `${automatedHeader(START_WORDS_REASON)} `;
	const opening = text.trimStart();
	return opening.startsWith(header) ? opening.slice(header.length) : undefined;
}

/** Whether a user message's text is one the harness sent rather than a person. */
export function isAutomatedText(text: string): boolean {
	const opening = text.trimStart();
	if (opening.startsWith(HEADER_OPENING)) return true;
	return LEGACY_OPENINGS.some((legacy) => opening.startsWith(legacy));
}
