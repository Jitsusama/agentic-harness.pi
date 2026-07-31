/**
 * Asking whether anybody objects before publishing a branch.
 *
 * This exists because of one seam. Publishing a branch is a working-layer
 * action, and the reason not to publish is often a hosting-layer fact: on a
 * backend with a merge queue, pushing to an enqueued branch ejects it and
 * everything speculatively batched with it, and re-running the checks for the
 * rest is measured in hundreds of jobs. The working layer cannot see that, and
 * teaching it to would mean giving it a route to the review contract, which is
 * the coupling this whole substrate exists to avoid.
 *
 * So it asks instead. Anything that knows something about a branch can object,
 * and the objection carries its own words: the layer that knows why is the layer
 * that explains it. Nothing here knows what a queue is.
 *
 * Silence means nobody objected, which is not the same as safe. That is the
 * honest reading and it is why this is an objection rather than an approval: a
 * check that nothing answers must not turn a push into a refusal, or a session
 * with no hosting provider loaded could never publish anything.
 */

/** What is about to be published. */
export interface PublishIntent {
	/** The repo, keyed the way the working layer keys one. */
	repoKey: string;
	/** The branch about to be pushed. */
	branch: string;
	/** Where it is being pushed from, for anything that needs to look. */
	treePath: string;
	/** True when the push would replace commits the remote already has. */
	replacing: boolean;
}

/** Somebody's reason not to publish. */
export interface Objection {
	/** Who is objecting, so a reader knows which system is worried. */
	from: string;
	/** Why, in words a person can act on. */
	reason: string;
	/** What to do instead, when there is a sensible alternative. */
	instead?: string;
}

/**
 * An objection collector, handed to whoever might have one.
 *
 * A function rather than a return value because the bus fans out: several
 * listeners may each have something to say, and the last one to answer must not
 * overwrite the first.
 */
export interface PublishReview {
	intent: PublishIntent;
	object(objection: Objection): void;
}

/**
 * Emitted before a branch is published, so anything that knows a reason to stop
 * can say so.
 *
 * Advisory by construction. A listener that throws, hangs or says nothing does
 * not prevent a push, because the alternative is a working layer that stops
 * working when an unrelated extension has a bad day.
 */
export const WORK_PUBLISH_CHECK = "work:publish:check:v1";

/**
 * Read a set of objections as one refusal, or nothing.
 *
 * Every objection is named and kept. Summarizing several into one would drop
 * whichever the reader most needed, and two systems objecting for two reasons is
 * a fact about the push rather than a formatting problem.
 */
export function refusalFrom(
	objections: readonly Objection[],
): string | undefined {
	if (objections.length === 0) return undefined;
	if (objections.length === 1) {
		const [only] = objections;
		return [
			`${only.from} says not to publish this yet. ${only.reason}`,
			...(only.instead === undefined ? [] : ["", only.instead]),
		].join("\n");
	}
	return [
		`${objections.length} systems say not to publish this yet.`,
		...objections.flatMap((one) => [
			"",
			`${one.from}: ${one.reason}`,
			...(one.instead === undefined ? [] : [`   ${one.instead}`]),
		]),
	].join("\n");
}
