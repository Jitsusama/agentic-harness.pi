/**
 * What to propose, worked out from the checkout you are standing in.
 *
 * Putting a branch up should not mean retyping three things git
 * already knows. The branch you are on is the head, the trunk is the
 * base, and the last commit's subject is a better title than most
 * people write twice.
 *
 * The provider deliberately infers none of this: it is handed explicit
 * values, because a layer that quietly overrules a caller who already
 * decided is a layer nobody can predict. That is not a contradiction
 * with what happens here, and the difference is worth stating, because
 * it is the whole design.
 *
 * **A guess is fine when somebody sees it.** This runs at the tool
 * layer, where the answer goes into a confirmation gate before
 * anything is sent, so every inference is on screen with a person
 * looking at it. That is why `guessed` exists and why it is not an
 * implementation detail: the gate reads it out. What is unacceptable
 * is a guess that reaches a backend without being shown, which is
 * exactly what a provider inferring a base from the current directory
 * would be.
 *
 * So it guesses freely and reports every guess, and refuses outright
 * where a wrong guess is expensive rather than merely wrong.
 */

/** What the checkout can tell us. */
export interface CheckoutFacts {
	/** The branch checked out, when the head is not detached. */
	branch?: string;
	/** The repo's trunk, when it is known. */
	trunk?: string;
	/** The last commit's subject. */
	subject?: string;
	/** Anything the commits offer as a description. */
	bodyFromCommits?: string;
	/** Whether the tree has uncommitted work in it. */
	dirty?: boolean;
}

/** What the caller already decided. */
export interface ProposalWanted {
	base?: string;
	head?: string;
	title?: string;
	body?: string;
}

/** Everything a propose call needs, and what was guessed. */
export interface ProposalFill {
	base: string;
	head: string;
	title: string;
	body: string;
	/** Fields that came from the checkout, for the gate to show. */
	guessed: string[];
	/** Things worth saying before this goes up. */
	warnings: string[];
}

/** Work out what to propose, or say what is missing. */
export function fillProposal(
	wanted: ProposalWanted,
	facts: CheckoutFacts,
): { fill: ProposalFill } | { refusal: string } {
	const guessed: string[] = [];

	const head = wanted.head ?? facts.branch;
	if (head === undefined) {
		return {
			refusal:
				"There is no branch checked out here and no head was named, so there is nothing to propose. Name the branch holding the work.",
		};
	}
	if (wanted.head === undefined) guessed.push("head");

	const base = wanted.base ?? facts.trunk;
	if (base === undefined) {
		// Not guessed at. A change proposed against something nobody
		// meant asks the wrong people to look at it, and on a busy repo
		// that is a notification to a team who now has to work out why.
		return {
			refusal:
				"This repo does not say what its trunk is, so there is nothing safe to target. Name the base this should merge into.",
		};
	}
	if (wanted.base === undefined) guessed.push("base");

	if (base === head) {
		return {
			refusal: `A change from ${head} onto itself is not a change. Check out the branch holding the work, or name a different base.`,
		};
	}

	const title = wanted.title ?? facts.subject;
	if (title === undefined) {
		return {
			refusal:
				"There is no commit here to take a title from, so one has to be given. A title is the first thing a reviewer reads.",
		};
	}
	if (wanted.title === undefined) guessed.push("title");

	const body = wanted.body ?? facts.bodyFromCommits ?? "";
	if (wanted.body === undefined && facts.bodyFromCommits !== undefined) {
		guessed.push("body");
	}

	const warnings: string[] = [];
	if (facts.dirty === true) {
		// A warning rather than a refusal, because proposing from a dirty
		// tree is legitimate: what goes up is what was pushed. But
		// somebody who forgot to commit wants to hear it now, not from a
		// reviewer reading a diff missing the last thing they wrote.
		warnings.push(
			"This tree has uncommitted work in it, which will not be part of the change. What goes up is what has been pushed.",
		);
	}

	return { fill: { base, head, title, body, guessed, warnings } };
}
