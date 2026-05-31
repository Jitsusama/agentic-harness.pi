/**
 * Stack-aware audit of inbound review threads.
 *
 * A reviewer commenting on one PR in a stack sees only that PR's
 * diff. They flag a gap the stack already closes downstream, or a
 * concern the PR's own later commits answer. This audit reads each
 * inbound review thread against the PR diff and the stack context
 * and returns an advisory verdict per thread — is the concern
 * already addressed, still valid, or unclear — so the user can
 * reply with confidence instead of re-litigating settled ground.
 *
 * The audit is its own action with its own input (threads) and
 * output (verdict-per-thread); it shares the dispatch and worktree
 * machinery with the council rounds but is deliberately not folded
 * into critique, whose input (judge findings) and output (position
 * per finding) differ. The output is advisory only: it never posts
 * or drafts replies, it informs the user's own reply.
 */

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { extractJson } from "./parse.js";
import type { ReviewThread } from "./threads.js";

/** A reviewer's concern, as judged against the diff and the stack. */
export const ThreadAuditDisposition = Type.Union([
	Type.Literal("addressed"),
	Type.Literal("valid"),
	Type.Literal("unclear"),
]);
export type ThreadAuditDisposition = Static<typeof ThreadAuditDisposition>;

const ThreadAuditVerdictSchema = Type.Object({
	threadId: Type.String({ minLength: 1 }),
	disposition: ThreadAuditDisposition,
	rationale: Type.String({ minLength: 1 }),
});

/** One thread's advisory audit verdict. */
export interface ThreadAuditVerdict {
	readonly threadId: string;
	readonly disposition: ThreadAuditDisposition;
	readonly rationale: string;
}

/** Outcome of parsing an audit subagent's response. */
export interface ThreadAuditParseResult {
	readonly verdicts: ThreadAuditVerdict[];
	readonly warnings: string[];
}

/** One PR in the stack, as context for the audit. */
export interface ThreadAuditStackEntry {
	readonly number: number;
	readonly title: string;
	readonly isCursor: boolean;
}

/** Inputs to {@link buildThreadAuditPrompt}. */
export interface BuildThreadAuditPromptInput {
	/** Inbound review threads to audit. Only unresolved threads are worth auditing. */
	readonly threads: readonly ReviewThread[];
	/** The stack the PR belongs to, cursor included; empty when the PR is standalone. */
	readonly stack: readonly ThreadAuditStackEntry[];
}

/**
 * Render the audit prompt: each inbound review thread with its id
 * and comments, the stack context, and the instruction to judge
 * per thread whether the PR diff or the rest of the stack already
 * addresses the reviewer's concern. The model reads the diff from
 * its worktree; the prompt carries the threads and the stack map.
 */
export function buildThreadAuditPrompt(
	input: BuildThreadAuditPromptInput,
): string {
	const sections: string[] = [];
	sections.push(
		"You are auditing inbound review threads on a pull request. A " +
			"reviewer who commented saw only this PR's diff in isolation. Your " +
			"job: for EACH thread, decide whether the concern is already " +
			"addressed — by this PR's own diff or by another PR in the stack — " +
			"or still valid, or unclear from what you can see.",
	);
	sections.push(
		"Dispositions:\n" +
			"  - addressed: the diff or the stack already does what the " +
			"reviewer asks. Cite where (which PR, which change).\n" +
			"  - valid: the concern stands; the code does not yet address it.\n" +
			"  - unclear: you cannot tell from the diff and stack available.",
	);
	sections.push(
		"This is advisory. You never post or draft replies; you inform the " +
			"user's own reply. Read the diff in your working directory before " +
			"judging; do not guess.",
	);
	if (input.stack.length > 0) {
		const lines = input.stack.map((pr) => {
			const marker = pr.isCursor ? " (this PR)" : "";
			return `  - #${pr.number}: ${pr.title}${marker}`;
		});
		sections.push(`## Stack\n${lines.join("\n")}`);
	} else {
		sections.push(
			"## Stack\nThis PR is standalone (no stack). Judge against the " +
				"PR's own diff only.",
		);
	}
	sections.push("## Threads");
	for (const thread of input.threads) {
		sections.push(renderThreadForAudit(thread));
	}
	sections.push(
		"## Output format\n" +
			"Return one fenced ```json block: " +
			'{ "verdicts": [ { "threadId": "<id>", "disposition": ' +
			'"addressed"|"valid"|"unclear", "rationale": "<one or two ' +
			'sentences citing the diff or stack>" } ] }. One verdict per ' +
			"thread, keyed by the thread id shown above.",
	);
	return sections.join("\n\n");
}

function renderThreadForAudit(thread: ReviewThread): string {
	const lines: string[] = [];
	const anchor =
		thread.path !== null
			? `${thread.path}${thread.line !== null ? `:${thread.line}` : ""}`
			: "(PR-level)";
	lines.push(`▸ [${thread.id}] ${anchor}`);
	for (const comment of thread.comments) {
		lines.push(`  ${comment.author}: ${comment.body}`);
	}
	return lines.join("\n");
}

/**
 * Parse an audit subagent's JSON response into per-thread
 * verdicts. Malformed entries are skipped with a warning rather
 * than failing the whole audit; a response with no JSON block or a
 * non-object top level yields no verdicts and one warning.
 */
export function parseThreadAuditOutput(text: string): ThreadAuditParseResult {
	const jsonText = extractJson(text);
	if (jsonText === null) {
		return {
			verdicts: [],
			warnings: ["Audit response contained no JSON block"],
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			verdicts: [],
			warnings: [`Audit JSON failed to parse: ${message}`],
		};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			verdicts: [],
			warnings: ["Audit JSON top-level was not an object"],
		};
	}
	const record = parsed as Record<string, unknown>;
	const rawVerdicts = Array.isArray(record.verdicts) ? record.verdicts : [];
	const verdicts: ThreadAuditVerdict[] = [];
	const warnings: string[] = [];
	for (let i = 0; i < rawVerdicts.length; i += 1) {
		const raw = rawVerdicts[i];
		if (!Value.Check(ThreadAuditVerdictSchema, raw)) {
			warnings.push(`Audit verdict at index ${i} is malformed; skipped`);
			continue;
		}
		// Schema's minLength accepts " "; drop whitespace-only
		// rationales so an empty verdict doesn't reach the user.
		if (raw.rationale.trim() === "") {
			warnings.push(`Audit verdict at index ${i} is malformed; skipped`);
			continue;
		}
		verdicts.push({
			threadId: raw.threadId,
			disposition: raw.disposition,
			rationale: raw.rationale,
		});
	}
	return { verdicts, warnings };
}
