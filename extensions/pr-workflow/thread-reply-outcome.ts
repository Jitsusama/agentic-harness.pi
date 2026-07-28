/**
 * The user-facing outcome of a thread reply, with or without a
 * combined resolve.
 *
 * Replying and resolving in one step has three outcomes worth
 * distinguishing: the reply alone (no resolve attempted), the reply
 * and the resolve both landing, and the reply landing while the
 * resolve fails. The third is the dangerous one — the reply is
 * already posted remotely, so reporting the whole action as a
 * failure would be a lie. This decides the text and details for all
 * three in one tested place, keeping the tool handler thin.
 */

/** The reply that landed: where it posted and what it said. */
export interface ReplyLanded {
	readonly threadIndex: number;
	/**
	 * Where it landed, when the provider says. Not every backend
	 * reports a link for what it just created, and a reply that
	 * posted without one still posted.
	 */
	readonly url?: string;
	readonly body: string;
}

/**
 * Where the reply landed, or an admission that we were not told.
 *
 * Interpolating an absent url would render "posted to [T1]: " and
 * read like a bug in us rather than a gap in what the provider
 * returned.
 */
function whereItLanded(url: string | undefined): string {
	return url ?? "(the provider did not say where)";
}

/** The resolve attempt's outcome, when one was made. */
export type ResolveOutcome =
	| { ok: true; isResolved: boolean }
	| { ok: false; error: string };

/** The text and structured details a tool result carries. */
export interface ReplyOutcome {
	readonly text: string;
	readonly details: Record<string, unknown>;
}

/**
 * Decide the text and details for a landed reply, optionally
 * combined with a resolve. A missing `resolve` means the reply
 * stood alone; a failed `resolve` keeps `ok: true` (the reply did
 * land) while naming the resolve error so the caller is not misled.
 */
export function describeReplyOutcome(
	reply: ReplyLanded,
	resolve: ResolveOutcome | undefined,
): ReplyOutcome {
	const tag = `[T${reply.threadIndex}]`;
	const common = {
		ok: true as const,
		url: reply.url,
		threadIndex: reply.threadIndex,
		body: reply.body,
	};
	const where = whereItLanded(reply.url);
	if (resolve === undefined) {
		return {
			text: `Reply posted to ${tag}: ${where}`,
			details: common,
		};
	}
	if (!resolve.ok) {
		return {
			text: `Reply posted to ${tag}: ${where}, but resolving failed: ${resolve.error}`,
			details: { ...common, resolved: false, resolveError: resolve.error },
		};
	}
	return {
		text: `Replied to and resolved ${tag}: ${where}`,
		details: { ...common, resolved: resolve.isResolved },
	};
}
