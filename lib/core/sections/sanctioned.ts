/**
 * The closed set of sanctioned section headings, one set per
 * artifact. Each entry is the exact heading string the body must
 * use: the hashes, the emoji and the name together. Beside the PR's
 * set sits its shape: what each of those sections may hold.
 *
 * These constants are the single source the gate enforces, but
 * the skills are the single source of truth for what the
 * conventions are.
 */

import type { BodyShape } from "./shape.ts";

/**
 * The PR body's four required sections, in order: the four questions a
 * reader who will not open the diff asks, in the order they ask them.
 * What is this, why was it needed, what did you do and why this way,
 * and why should I believe it.
 */
export const PR_SECTIONS = [
	"### 💡 TL;DR",
	"### 🧩 Problem",
	"### 🔧 Solution",
	"### 🔬 Validation",
] as const;

/**
 * What each PR section may hold, from the github-pr-format skill. The
 * TL;DR is an eight-second read: 40 words at the 238 words a minute an
 * adult reads non-fiction. The other ceilings were set by experiment:
 * writers treat a ceiling as a target, and at 180, 300 and 180 words the
 * descriptions grew longer than the ones they replaced. At these, a
 * whole description stays under about two minutes of reading while a
 * complex change still has room to explain itself.
 *
 * A change of 10,000 changed lines or more, about one PR in two hundred
 * across the three repositories this was set from, may go deeper inside
 * Problem, Solution and Validation, below an opening held to the same
 * ceiling. The parts are capped one by one rather than the section as
 * a whole, because a writer fills whatever room a ceiling gives, and
 * the one table is counted by its rows, since exact values compared
 * side by side are what a table is for.
 */
export const PR_SHAPE: BodyShape = {
	headingFirst: true,
	sentenceWords: 40,
	depth: {
		fromLines: 10_000,
		sections: [PR_SECTIONS[1], PR_SECTIONS[2], PR_SECTIONS[3]],
		partHashes: "####",
		parts: 8,
		partWords: 150,
		tableIn: PR_SECTIONS[3],
		tableRows: 12,
		cellWords: 12,
	},
	sections: {
		[PR_SECTIONS[0]]: {
			words: 40,
			sentences: 2,
			codeSpans: 0,
			bullets: 0,
			links: 0,
			headline: true,
		},
		[PR_SECTIONS[1]]: { words: 120, codeSpans: 3, bullets: 0 },
		[PR_SECTIONS[2]]: {
			words: 200,
			codeSpans: 8,
			bullets: 5,
			noArtifactLists: true,
		},
		[PR_SECTIONS[3]]: { words: 100, bullets: 5 },
	},
};

/** The issue body's three required sections, in order. */
export const ISSUE_SECTIONS = [
	"### 🌐 Situation",
	"### 🎯 Outcome",
	"### ✅ Acceptance",
] as const;
