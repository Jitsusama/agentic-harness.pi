/**
 * How anything that was asked ended: a gate answered, a send made or
 * refused, a run finished.
 *
 * A gate's record, a Slack send and a spawned agent all end one of
 * three ways, and they were drawn with two crosses. The gates and the
 * Slack and Google tools wrote a ballot x for a cancel, a refusal and
 * a failure alike, while review, the footer and the spawned-agent set
 * wrote a multiplication cross for a failure and a minus for a cancel.
 * So one session showed two marks for failing, and a cancel that read
 * as one.
 *
 * So the marks live here, and the spawned-agent set takes its three
 * endings from them. A refusal takes the cross, as `GLYPH.rejected`
 * does: what was asked for did not happen, and someone said so.
 */

/** How something asked of the session ended. */
export type Outcome = "done" | "cancelled" | "failed";

/** The mark for each ending, and the only place these three are spelled. */
export const OUTCOME_GLYPH: Record<Outcome, string> = {
	done: "\u2713",
	// Neither a tick nor a cross: somebody stopped it, so it did not pass
	// and did not fail.
	cancelled: "\u2212",
	failed: "\u2715",
};
