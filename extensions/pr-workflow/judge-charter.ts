/**
 * The judge's charter — its standing law.
 *
 * The judge is not a reviewer and holds no lens. Where a reviewer
 * wears a persona charter as its system prompt, the judge wears
 * this one: a fixed law that says consolidate, never adopt a
 * perspective. There is no judge library and no judge persona — one
 * charter, loaded from `judge.md` beside the personas when present,
 * else this built-in default. Per-run intent (a stricter or more
 * lenient pass) rides in the user prompt, never here.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	reviewQualityStandard,
	reviewSynthesisStandard,
} from "./review-quality-standard.js";

const JUDGE_CHARTER_FILENAME = "judge.md";

/**
 * The built-in judge charter: identity, the no-persona stance and
 * the synthesis discipline, followed by the shared review-quality
 * and synthesis standards. This is the system prompt the judge
 * runs under when no `judge.md` override is present.
 */
export function defaultJudgeCharter(): string {
	const lines: string[] = [];
	lines.push(
		"You are the judge in a multi-reviewer code-review council. " +
			"You receive each reviewer's findings on the same pull request " +
			"and must synthesize them into ONE consolidated list. Merge " +
			"similar findings, tighten prose, and reconcile conflicting " +
			"decorations.",
	);
	lines.push("");
	lines.push(
		"You are not a reviewer and you hold no lens of your own. The " +
			"reviewers' personas are exhibits you adjudicate, never a " +
			'perspective you adopt: a "privilege-escalation judge" is a ' +
			"contradiction, and you do not become one. Weigh what the " +
			"personas surfaced; do not inherit their disposition.",
	);
	lines.push("");
	lines.push("Discipline:");
	lines.push(
		"- Synthesize, do not concatenate. Two reviewers raising the " +
			"same issue become ONE consolidated finding listing both in " +
			"`raisedBy`.",
	);
	lines.push(
		"- Priority order: Security → Correctness → Architecture → " +
			"Performance → API stability → Tests → Style.",
	);
	lines.push(
		"- Cap `praise` findings at 2–3 across the whole consolidated " +
			"list. Suggestion overload (>8 on a single file) is a smell; " +
			"prefer dropping noise to keeping it.",
	);
	lines.push(
		"- Favour keep over drop when uncertain. The user reviews next " +
			"and will dismiss noise; you cannot resurface what you drop.",
	);
	lines.push(
		"- Preserve source line locations. When the findings you are " +
			"consolidating anchor to specific lines in the same file, the " +
			"consolidated finding's location is line-kind with start/end " +
			"covering the sources. Collapsing to file-kind discards the " +
			"specificity GitHub needs to post inline; only do it when sources " +
			"genuinely disagree on where the issue lives.",
	);
	lines.push("");
	lines.push(reviewQualityStandard());
	lines.push("");
	lines.push(reviewSynthesisStandard());
	return lines.join("\n");
}

/**
 * Resolve the judge charter: the body of `judge.md` in `dir` when
 * it exists and is non-empty, otherwise {@link defaultJudgeCharter}.
 * The override file is plain prose — no frontmatter — because the
 * judge has no identity fields to carry; it is the law, not a lens.
 */
export async function resolveJudgeCharter(dir: string): Promise<string> {
	try {
		const text = await readFile(join(dir, JUDGE_CHARTER_FILENAME), "utf8");
		const trimmed = text.trim();
		if (trimmed !== "") return trimmed;
	} catch (error) {
		// A missing judge.md is the common case — the built-in
		// default is the charter. Only a real read error (not
		// ENOENT) is worth surfacing, and even then the default
		// keeps the judge runnable, so we fall through.
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
	}
	return defaultJudgeCharter();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
