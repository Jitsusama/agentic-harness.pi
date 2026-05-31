/**
 * The `audit-threads` action: a stack-aware, advisory audit of
 * inbound review threads.
 *
 * Fetches the loaded PR's unresolved review threads, builds the
 * audit prompt with the stack context, dispatches one auditor
 * subagent inside the PR's worktree, and parses a verdict per
 * thread. The result is advisory: it never posts or drafts
 * replies. It tells the user which inbound threads the diff or the
 * stack already answers, so they can reply without re-litigating
 * settled ground.
 */

import type { CouncilReviewer } from "../../lib/subagent/subagent.js";
import type { CouncilDispatch } from "./council.js";
import type { PrWorkflowState } from "./state.js";
import {
	buildThreadAuditPrompt,
	parseThreadAuditOutput,
	type ThreadAuditStackEntry,
	type ThreadAuditVerdict,
} from "./thread-audit.js";
import { loadThreadsAction, type ThreadsFetcher } from "./threads-action.js";
import type { WorktreeRegistry } from "./worktree.js";

/** Inputs for {@link auditThreadsAction}. */
export interface AuditThreadsActionInput {
	readonly state: PrWorkflowState;
	readonly registry: WorktreeRegistry;
	readonly dispatch: CouncilDispatch;
	/** The auditor model; the tool passes the configured judge. */
	readonly auditor: CouncilReviewer;
	readonly fetchThreads: ThreadsFetcher;
	readonly signal?: AbortSignal;
}

/** Outcome of the audit action. */
export type AuditThreadsActionResult =
	| { ok: true; verdicts: ThreadAuditVerdict[]; warnings: string[] }
	| { ok: false; error: string };

/**
 * Run the stack-aware thread audit. Refuses without a loaded PR;
 * returns an empty advisory when there are no unresolved inbound
 * threads to audit.
 */
export async function auditThreadsAction(
	input: AuditThreadsActionInput,
): Promise<AuditThreadsActionResult> {
	const { state } = input;
	if (state.pr === null || state.pr.metadata === null) {
		return {
			ok: false,
			error: "No PR is loaded. Call pr_workflow action=load first.",
		};
	}

	const loaded = await loadThreadsAction({
		state,
		fetcher: input.fetchThreads,
	});
	if (!loaded.ok) return { ok: false, error: loaded.error };

	// Only unresolved inline review threads are worth auditing: a
	// resolved thread is already settled, and PR-level comments are
	// context, not a concern to adjudicate.
	const threads = loaded.snapshot.threads.filter(
		(t) => t.kind === "review-thread" && !t.isResolved,
	);
	if (threads.length === 0) {
		return { ok: true, verdicts: [], warnings: [] };
	}

	const stack = buildStackEntries(state);
	const prompt = buildThreadAuditPrompt({ threads, stack });

	const metadata = state.pr.metadata;
	const handle = await input.registry.ensure({
		owner: state.pr.reference.owner,
		repo: state.pr.reference.repo,
		sha: metadata.head.sha,
		...(metadata.head.ref ? { branch: metadata.head.ref } : {}),
	});

	const dispatched = await input.dispatch({
		reviewer: input.auditor,
		prompt,
		cwd: handle.path,
		signal: input.signal,
	});
	const parsed = parseThreadAuditOutput(dispatched.finalAssistantText);
	return {
		ok: true,
		verdicts: parsed.verdicts,
		warnings: [...dispatched.warnings, ...parsed.warnings],
	};
}

function buildStackEntries(state: PrWorkflowState): ThreadAuditStackEntry[] {
	const stack = state.pr?.stack;
	if (!stack) return [];
	return stack.entries.map((entry, index) => ({
		number: entry.reference.number,
		title: entry.title,
		isCursor: index === stack.cursorIndex,
	}));
}

/**
 * Render the advisory audit as human-readable text: the threads
 * the diff or stack already addresses, surfaced first, then the
 * ones still valid, then the unclear ones, each with its rationale.
 */
export function formatThreadAudit(
	verdicts: readonly ThreadAuditVerdict[],
): string {
	if (verdicts.length === 0) {
		return "No unresolved inbound threads to audit.";
	}
	const order: ThreadAuditVerdict["disposition"][] = [
		"addressed",
		"valid",
		"unclear",
	];
	const heading: Record<ThreadAuditVerdict["disposition"], string> = {
		addressed: "Already addressed (by the diff or the stack):",
		valid: "Still valid:",
		unclear: "Unclear:",
	};
	const lines: string[] = [];
	for (const disposition of order) {
		const group = verdicts.filter((v) => v.disposition === disposition);
		if (group.length === 0) continue;
		lines.push(heading[disposition]);
		for (const v of group) {
			lines.push(`  [${v.threadId}] ${v.rationale}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}
