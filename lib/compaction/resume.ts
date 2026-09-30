/**
 * The messages that resume a run a compaction interrupted.
 *
 * They are user messages, so the session log holds them exactly as it
 * holds what a person typed. Anything reading the log that needs to tell
 * the two apart, a run is what follows one typed message, recognises
 * these by their opening, which is why the text lives here rather than
 * inside the workflow that sends it.
 */

/** Sent once a compaction lands, to carry on the run it stopped. */
export const RESUME_TEXT =
	"The context was compacted to keep this session affordable. Carry on " +
	"with the task you were working on from where you left off.";

/** Sent once a compaction fails, to carry on the run it stopped. */
export const FAILED_RESUME_TEXT =
	"Compacting the context failed, so it was left as it is. Carry on " +
	"with the task you were working on from where you left off.";

/**
 * The sentence each message opens with. A message is matched on its
 * opening rather than as a whole, since other extensions may append
 * their own context to a message on its way into the log.
 */
const OPENINGS = [RESUME_TEXT, FAILED_RESUME_TEXT].map((text) =>
	text.slice(0, text.indexOf(".") + 1),
);

/** Whether a user message's text is one the harness sent to resume a run. */
export function isResumeText(text: string): boolean {
	const opening = text.trimStart();
	return OPENINGS.some((sentence) => opening.startsWith(sentence));
}
