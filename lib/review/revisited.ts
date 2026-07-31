/**
 * Whether you have reviewed this before, and whether it has moved since.
 *
 * Re-reviewing a change means reading the whole diff again and hoping to notice
 * which parts are new. That is the wrong job for a person: the backend knows
 * which commit was on top when the review was posted, and nothing was recording
 * it.
 *
 * So it is recorded, per change, when a review is published. What that buys is
 * modest and worth being precise about. It says whether the change has moved
 * since you last looked, which is the difference between re-reading a diff and
 * knowing you do not have to. It does not say what changed: a diff between two
 * commits needs the commits, which means a local tree, and a backend that
 * publishes no fetchable ref cannot supply one. Where that is possible the
 * caller can go and take the diff itself; where it is not, knowing the change
 * has moved is still the answer to the question people actually ask.
 *
 * The store is deliberately dumb. It is a record of what happened, not a cache:
 * nothing here is derived, so nothing here can go stale in a way that lies.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeRef, Proposal } from "./change.js";
import { changeKey } from "./keys.js";

/** A review you posted, and the change as it stood then. */
export interface Visit {
	/** The change, keyed the way every other store here keys one. */
	key: string;
	/** The tip commit when the review was posted, when the backend said. */
	commit?: string;
	/** When, as an ISO instant. */
	at: string;
	/** What the review said as a whole, for a listing. */
	verdict?: string;
}

/** Where a change stands relative to the last time you reviewed it. */
export type SinceLastVisit =
	| { kind: "never" }
	| {
			kind: "unmoved";
			visit: Visit;
	  }
	| {
			kind: "moved";
			visit: Visit;
			/** The tip now. */
			commit: string;
	  }
	| {
			kind: "cannot-tell";
			visit: Visit;
			/** Why, in words. */
			because: string;
	  };

/** Recording and reading the reviews you have posted. */
export interface VisitLog {
	record(ref: ChangeRef, visit: Omit<Visit, "key">): Visit;
	/** The most recent visit to this change, if any. */
	last(ref: ChangeRef): Visit | undefined;
	/** Every visit, newest first. */
	all(): readonly Visit[];
}

/** A file name that cannot collide or escape its directory. */
function fileFor(key: string): string {
	return `${key.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`;
}

/**
 * A log of reviews posted, kept as one file per change.
 *
 * One file per change rather than one file for everything, for the same reason
 * the attachment store is: two sessions reviewing two changes at once write to
 * two files and neither has to merge the other's.
 */
export function createVisitLog(dir: string): VisitLog {
	function read(): Visit[] {
		let names: string[];
		try {
			names = readdirSync(dir).filter((name) => name.endsWith(".json"));
		} catch {
			// No directory yet means nothing has been reviewed, which is a
			// state and not a failure.
			return [];
		}
		const found: Visit[] = [];
		for (const name of names) {
			try {
				const held = JSON.parse(readFileSync(join(dir, name), "utf8"));
				if (
					typeof held === "object" &&
					held !== null &&
					typeof held.key === "string" &&
					typeof held.at === "string"
				) {
					found.push(held as Visit);
				}
			} catch {
				// A half-written or hand-edited file is skipped rather than
				// bringing down every other answer with it.
			}
		}
		return found.sort((one, other) => other.at.localeCompare(one.at));
	}

	return {
		record(ref, visit) {
			const key = changeKey(ref);
			const held: Visit = { ...visit, key };
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, fileFor(key)), JSON.stringify(held, null, 2));
			return held;
		},

		last(ref) {
			const key = changeKey(ref);
			return read().find((visit) => visit.key === key);
		},

		all: read,
	};
}

/**
 * What has happened to a change since you last reviewed it.
 *
 * Four answers rather than a boolean, because a caller acts differently on each
 * and collapsing them loses the distinction that matters. Never reviewed is not
 * the same as reviewed and unchanged, and neither is the same as a backend that
 * will not say which commit is on top: that last one has to read as its own
 * answer, or a change that moved silently looks like one that did not move.
 */
export function sinceLastVisit(
	visit: Visit | undefined,
	proposal: Proposal,
): SinceLastVisit {
	if (visit === undefined) return { kind: "never" };
	if (visit.commit === undefined) {
		return {
			kind: "cannot-tell",
			visit,
			because:
				"the tip commit was not recorded when you reviewed, so there is nothing to compare against",
		};
	}
	if (proposal.headCommit === undefined) {
		return {
			kind: "cannot-tell",
			visit,
			because: "this backend does not report which commit is on top",
		};
	}
	if (proposal.headCommit === visit.commit) return { kind: "unmoved", visit };
	return { kind: "moved", visit, commit: proposal.headCommit };
}

/** Said in words, for a listing. */
export function describeVisit(said: SinceLastVisit): string {
	switch (said.kind) {
		case "never":
			return "You have not reviewed this before.";
		case "unmoved":
			return `You reviewed this on ${said.visit.at.slice(0, 10)} and it has not moved since.`;
		case "moved":
			return `You reviewed this on ${said.visit.at.slice(0, 10)} at ${said.visit.commit?.slice(0, 12)}. It is now at ${said.commit.slice(0, 12)}, so there is new work to read.`;
		case "cannot-tell":
			return `You reviewed this on ${said.visit.at.slice(0, 10)}, but ${said.because}.`;
	}
}
