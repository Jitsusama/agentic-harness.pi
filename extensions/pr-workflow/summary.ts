/**
 * One-shot status panel for the loaded PR.
 *
 * Renders everything pi knows about the current PR in a
 * single text block: metadata, stack position, inbound
 * threads, council state, fix queue. Read-only and
 * non-mutating — purely a presentation convenience for
 * "what's the state of this PR?" questions.
 *
 * Cached snapshots only. The threads section reads
 * `state.threads`; if it's null, the section prompts the
 * user to run `action=threads` rather than firing a live
 * GraphQL fetch. Same philosophy for council, judge,
 * critique: never run anything as a side effect of
 * summarising.
 */

import { summarizeFixQueue } from "./fix.js";
import type { PrWorkflowState } from "./state.js";

/** A reviewer roster + judge selection at a glance. */
function councilConfigLine(state: PrWorkflowState): string {
	const roster = state.council.roster;
	const judge = state.council.judge;
	const rosterText =
		roster.length === 0
			? "unconfigured"
			: `${roster.length} reviewer(s) [${roster.map((r) => r.id).join(", ")}]`;
	const judgeText = judge === null ? "no judge" : `judge: ${judge.id}`;
	return `  council: ${rosterText}, ${judgeText}`;
}

/** Round-by-round progress for the council pipeline. */
function councilProgressLines(state: PrWorkflowState): string[] {
	const lines: string[] = [];
	const run = state.council.lastRun;
	const judge = state.council.lastJudge;
	const critique = state.council.lastCritique;

	if (run === null && judge === null && critique === null) {
		lines.push("  no council run yet");
		return lines;
	}

	if (run !== null) {
		const findingsCount = run.reviewerOutputs.reduce(
			(acc, r) => acc + r.findings.length,
			0,
		);
		lines.push(`  round 1 (council): ${findingsCount} finding(s)`);
	}
	if (judge !== null) {
		lines.push(
			`  round 2 (judge): ${judge.consolidatedFindings.length} consolidated finding(s)`,
		);
	}
	if (critique !== null) {
		lines.push(
			`  round 3 (critique): ${critique.reviewerOutputs.length} reviewer position(s)`,
		);
	}
	return lines;
}

/** A breakdown of decisions across endorse / fix / dismiss / etc. */
function decisionsLine(state: PrWorkflowState): string | null {
	const decisions = state.council.decisions;
	if (decisions.size === 0) return null;
	const buckets = new Map<string, number>();
	for (const d of decisions.values()) {
		buckets.set(d.verdict, (buckets.get(d.verdict) ?? 0) + 1);
	}
	const parts: string[] = [];
	for (const [verdict, count] of buckets) {
		parts.push(`${count} ${verdict}`);
	}
	return `  decisions: ${decisions.size} (${parts.join(", ")})`;
}

/** Stack position rendered with the cursor PR highlighted. */
function stackLines(state: PrWorkflowState): string[] {
	if (state.pr === null || state.pr.stack === null) return [];
	const stack = state.pr.stack;
	if (stack.entries.length <= 1) return [];
	const cursorNumber = state.pr.reference.number;
	const lines: string[] = ["", "Stack:"];
	for (let i = 0; i < stack.entries.length; i += 1) {
		const entry = stack.entries[i];
		const marker = entry.reference.number === cursorNumber ? "→" : " ";
		const position = `${i + 1}/${stack.entries.length}`;
		lines.push(
			`  ${marker} ${position} #${entry.reference.number} ${entry.title}`,
		);
	}
	return lines;
}

/**
 * Format a `cached <when>` / `updated locally <when>`
 * label so the user knows whether the counts came from
 * a fresh fetch or are reflecting in-session mutations
 * on top of an older snapshot.
 */
function formatCacheLabel(snapshot: {
	fetchedAt: string;
	mutatedAt: string | null;
}): string {
	const base = `cached ${snapshot.fetchedAt}`;
	if (snapshot.mutatedAt) {
		return `${base} (updated locally ${snapshot.mutatedAt}; re-run \`action=threads\` to refresh)`;
	}
	return `${base} (re-run \`action=threads\` to refresh)`;
}

/** Threads section: counts + the first few open thread excerpts. */
function threadsLines(state: PrWorkflowState): string[] {
	if (state.threads === null) {
		return ["", "Threads: not fetched (run `action=threads` to fetch)."];
	}
	const all = state.threads.threads;
	const open = all.filter((t) => !t.isResolved && !t.isOutdated);
	const resolved = all.filter((t) => t.isResolved).length;
	const outdated = all.filter((t) => t.isOutdated && !t.isResolved).length;
	if (all.length === 0) {
		return ["", "Threads: none on this PR."];
	}
	const header = `Threads: ${open.length} open, ${resolved} resolved, ${outdated} outdated`;
	const lines: string[] = ["", header];
	lines.push(`  ${formatCacheLabel(state.threads)}`);
	const PREVIEW_LIMIT = 3;
	const previewable = open.slice(0, PREVIEW_LIMIT);
	for (let i = 0; i < previewable.length; i += 1) {
		const t = previewable[i];
		const index = all.indexOf(t) + 1;
		const location =
			t.path === null
				? "(PR-level)"
				: t.line === null
					? t.path
					: `${t.path}:${t.line}`;
		const first = t.comments[0];
		const author = first ? `@${first.author}` : "@?";
		const excerpt = first ? excerptComment(first.body) : "";
		lines.push(`  [T${index}] ${location}  ${author}  "${excerpt}"`);
	}
	if (open.length > PREVIEW_LIMIT) {
		lines.push(
			`  (+${open.length - PREVIEW_LIMIT} more open; see action=threads)`,
		);
	}
	return lines;
}

const EXCERPT_MAX = 60;

function excerptComment(body: string): string {
	const collapsed = body.replace(/\s+/g, " ").trim();
	if (collapsed.length <= EXCERPT_MAX) return collapsed;
	return `${collapsed.slice(0, EXCERPT_MAX - 1)}…`;
}

/** Council section: config, progress, decisions. */
function councilLines(state: PrWorkflowState): string[] {
	const lines: string[] = ["", "Council:"];
	lines.push(councilConfigLine(state));
	for (const line of councilProgressLines(state)) {
		lines.push(line);
	}
	const decisions = decisionsLine(state);
	if (decisions !== null) {
		lines.push(decisions);
	}
	return lines;
}

/** Fix queue section: only rendered when there's something to say. */
function fixQueueLines(state: PrWorkflowState): string[] {
	const queue = summarizeFixQueue(state);
	if (queue.pending === 0 && queue.committed === 0 && queue.skipped === 0) {
		return [];
	}
	const parts = [
		`${queue.pending} pending`,
		`${queue.committed} committed`,
		`${queue.skipped} skipped`,
	];
	return ["", `Fix queue: ${parts.join(", ")}`];
}

/**
 * Render the full summary as a single text block.
 *
 * When no PR is loaded the summary is a one-liner so the
 * caller knows to run `load` first. Otherwise the panel
 * has up to five sections — header, stack, threads,
 * council, fix queue — emitted in this order. Sections
 * with nothing to say are omitted, not rendered as
 * placeholders.
 */
export function formatPrSummary(state: PrWorkflowState): string {
	if (state.pr === null) {
		return "No PR loaded. Run `action=load` with a PR reference first.";
	}
	const ref = state.pr.reference;
	const metaTitle = state.pr.metadata?.title ?? "(metadata not fetched)";
	const lines: string[] = [];
	lines.push(`PR ${ref.owner}/${ref.repo}#${ref.number}: ${metaTitle}`);
	if (state.pr.metadata !== null) {
		const meta = state.pr.metadata;
		const stateLabel = meta.isDraft ? "draft" : meta.state.toLowerCase();
		lines.push(
			`  author: @${meta.author}  ·  state: ${stateLabel}  ·  +${meta.additions} -${meta.deletions} across ${meta.changedFiles} file(s)`,
		);
	}
	for (const line of stackLines(state)) lines.push(line);
	for (const line of threadsLines(state)) lines.push(line);
	for (const line of councilLines(state)) lines.push(line);
	for (const line of fixQueueLines(state)) lines.push(line);
	return lines.join("\n");
}
