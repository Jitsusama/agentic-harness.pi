/**
 * The message `work record` commits, put in its right form first.
 *
 * A body line past 72 columns has exactly one right form, so refusing it
 * taught nothing and cost a turn: twenty refusals since 12 October, each
 * for a line a few characters over. The body is wrapped here and the
 * caller is told it was, so the agent learns the width without paying for
 * it. A subject past its limit is not wrapped, since choosing what to cut
 * from it is judgement, and the shape check after this still refuses it.
 */

import { wrapBody } from "@jitsusama/agentic-harness.core/guardian/commit-format";

/** What `work record` commits and checks. */
export interface RecordMessage {
	/** The body as it will be committed, or none when none was given. */
	body: string | undefined;
	/** Subject and body as one message, which is what the gates read. */
	proposed: string;
	/** Whether wrapping changed the body, so the answer can say so. */
	wrapped: boolean;
}

/** The message for a subject and an optional body, body wrapped to 72. */
export function recordMessage(
	subject: string,
	body: string | undefined,
): RecordMessage {
	const given = body === undefined || body === "" ? undefined : body;
	const wrappedBody = given === undefined ? undefined : wrapBody(given);
	return {
		body: wrappedBody,
		proposed: [subject, wrappedBody]
			.filter((part) => part !== undefined && part !== "")
			.join("\n\n"),
		wrapped: wrappedBody !== given,
	};
}
