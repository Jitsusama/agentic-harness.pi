/**
 * The messages that resume a run a compaction interrupted.
 *
 * They are user messages, since a run has to start through pi's prompt
 * path to keep the system prompt (see `lib/internal/automated.ts`), so
 * they open with the automated header. A run is what follows one typed
 * message, and anything reading the log tells these apart by that
 * header, or by the opening they had before it.
 */

import { automatedHeader, automatedText } from "../internal/automated.ts";

const CARRY_ON =
	"Carry on with what you were working on, from where you left off.";

/** Why a resume after a compaction landed was sent. */
const COMPACTED = "the context was compacted to keep this session affordable";

/** Why a resume after a compaction failed was sent. */
const FAILED = "compacting the context failed, so it was left as it is";

/** Sent once a compaction lands, to carry on the run it stopped. */
export const RESUME_TEXT = automatedText(COMPACTED, CARRY_ON);

/** Sent once a compaction fails, to carry on the run it stopped. */
export const FAILED_RESUME_TEXT = automatedText(FAILED, CARRY_ON);

/**
 * How each opens, today and before the header. A message is matched
 * on its opening rather than as a whole, since other extensions may
 * append their own context to a message on its way into the log.
 */
const OPENINGS = [
	automatedHeader(COMPACTED),
	automatedHeader(FAILED),
	"The context was compacted to keep this session affordable.",
	"Compacting the context failed, so it was left as it is.",
];

/** Whether a user message's text is one the harness sent to resume a run. */
export function isResumeText(text: string): boolean {
	const opening = text.trimStart();
	return OPENINGS.some((sentence) => opening.startsWith(sentence));
}
