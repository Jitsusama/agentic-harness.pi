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
	/**
	 * Whether this stops the push or merely says something about it.
	 *
	 * The distinction is not politeness, it is the difference between a guard
	 * people keep and a guard people disable. A backend that knows a change is
	 * queued can block; a backend that only knows it *would* refuse a queued
	 * change, without being able to say whether this one is queued, has a real
	 * thing to tell you and no business stopping every push you make. Blocking
	 * on a suspicion would refuse every push on such a backend, and a guard
	 * that refuses everything protects nothing once it is turned off.
	 *
	 * Defaults to blocking, since an objection whose author did not think about
	 * this is more likely to be a genuine one.
	 */
	blocking?: boolean;
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
	const blocking = objections.filter((one) => one.blocking !== false);
	if (blocking.length === 0) return undefined;
	if (blocking.length === 1) {
		const [only] = blocking;
		return [
			`${only.from} says not to publish this yet. ${only.reason}`,
			...(only.instead === undefined ? [] : ["", only.instead]),
		].join("\n");
	}
	return [
		`${blocking.length} systems say not to publish this yet.`,
		...blocking.flatMap((one) => [
			"",
			`${one.from}: ${one.reason}`,
			...(one.instead === undefined ? [] : [`   ${one.instead}`]),
		]),
	].join("\n");
}

/**
 * What was said that did not stop the push, to print beside what happened.
 *
 * Said after the fact rather than before it, because that is what a caution is:
 * it decorates the outcome instead of becoming one. Printed at all because the
 * alternative is a backend that knows something useful and has no way to say it
 * without also blocking.
 */
export function cautionsFrom(
	objections: readonly Objection[],
): readonly string[] {
	return objections
		.filter((one) => one.blocking === false)
		.map((one) =>
			[
				`${one.from}: ${one.reason}`,
				...(one.instead === undefined ? [] : [one.instead]),
			].join(" "),
		);
}
