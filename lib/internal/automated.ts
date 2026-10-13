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

/** Whether a user message's text is one the harness sent rather than a person. */
export function isAutomatedText(text: string): boolean {
	const opening = text.trimStart();
	if (opening.startsWith(HEADER_OPENING)) return true;
	return LEGACY_OPENINGS.some((legacy) => opening.startsWith(legacy));
}
