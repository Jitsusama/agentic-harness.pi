import type {
	CostSlice,
	LedgerTotal,
	PaybackReplay,
	RegretReport,
	RepeatedCall,
	VerifierOutcome,
} from "@jitsusama/agentic-harness.core/observability";
import type { FanOutSummary, FanOutView } from "./fanout.ts";

/** What indexing a corpus of session logs did. */
export interface IndexOutcome {
	readonly files: number;
	readonly scanned: number;
	readonly skipped: number;
	readonly lines: number;
	readonly unparseable: number;
	readonly inserted: number;
	readonly duplicates: number;
	readonly insertedCalls: number;
	readonly duplicateCalls: number;
	readonly insertedDropped: number;
	readonly seconds: number;
}

/** Widest a slice key is printed before it is elided. */
const KEY_WIDTH = 42;

function money(value: number): string {
	return value >= 100
		? `$${Math.round(value).toLocaleString()}`
		: `$${value.toFixed(2)}`;
}

function elide(text: string, max = KEY_WIDTH): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * State the ledger's own blind spots beside its total. An aggregate that
 * cannot say what it missed is not evidence, so unmetered turns are
 * reported rather than folded into the number as zero.
 */
export function formatTotal(total: LedgerTotal): string {
	const lines = [
		`${money(total.cost)} over ${total.turns.toLocaleString()} turns`,
	];
	if (total.unmetered > 0) {
		lines.push(
			`  ${total.unmetered.toLocaleString()} turns carried no usage, so they ` +
				`cost an unknown amount and are counted but not priced`,
		);
	}
	if (total.cacheWriteTokens > 0) {
		const share = (total.cacheWrite1hTokens / total.cacheWriteTokens) * 100;
		lines.push(
			`  cache writes: ${(total.cacheWriteTokens / 1e9).toFixed(2)}B tokens, ` +
				`${share.toFixed(1)}% at the one-hour rate`,
		);
	}
	return lines.join("\n");
}

/**
 * Render a dimension's slices heaviest first, keeping the unattributed
 * slice visible with its share named. Hiding it would make every other
 * share a fraction of a total that excluded it.
 */
export function formatSlices(
	title: string,
	slices: readonly CostSlice[],
	limit = 12,
): string {
	if (slices.length === 0) return `${title}: nothing recorded.`;
	const whole = slices.reduce((n, s) => n + s.cost, 0);
	const named = slices.filter((s) => s.key !== "");
	const blank = slices.find((s) => s.key === "");
	const head =
		blank && whole > 0
			? `${title} (${named.length} named, ${money(blank.cost)} unattributed, ` +
				`${((blank.cost / whole) * 100).toFixed(0)}%)`
			: `${title} (${named.length})`;

	const rows = named.slice(0, limit).map((s) => {
		const per = s.turns > 0 ? s.cost / s.turns : 0;
		return (
			`  ${elide(s.key).padEnd(KEY_WIDTH)} ${money(s.cost).padStart(9)}` +
			`  ${s.turns.toLocaleString().padStart(9)} turns` +
			`  $${per.toFixed(3)}/turn`
		);
	});
	if (named.length > limit) {
		rows.push(`  ${named.length - limit} more, ask for a larger limit`);
	}
	return [head, ...rows].join("\n");
}

/**
 * Render the run store's fan-out beside the ledger total. The ledger
 * indexes session logs and subagents write none, so without this the
 * total reads as everything while leaving out every subagent and
 * review round.
 */
export function formatFanOut(
	summary: FanOutSummary,
	view?: FanOutView,
): string {
	const noun = summary.runs === 1 ? "run" : "runs";
	// The run store starts months after the ledger, so the two totals
	// cover different windows. Naming the start is what stops a reader
	// adding them.
	const since =
		summary.since === undefined
			? ""
			: ` since ${new Date(summary.since).toISOString().slice(0, 10)}`;
	const lines = [
		`Fan-out, not in the total above: ${money(summary.cost)} over ` +
			`${summary.runs.toLocaleString()} subagent ${noun} in the run store${since}`,
	];
	if (view?.dimension !== "kind") {
		lines.push(
			`  ${summary.byKind.map((k) => `${k.key} ${money(k.cost)}`).join(", ")}`,
		);
	}
	if (summary.unmetered > 0) {
		const one = summary.unmetered === 1;
		lines.push(
			`  ${summary.unmetered.toLocaleString()} ${one ? "run" : "runs"} carried no usage, ` +
				`so ${one ? "it costs" : "they cost"} an unknown amount and ` +
				`${one ? "is" : "are"} counted but not priced`,
		);
	}
	if (view?.slices) {
		const named = view.slices.filter((s) => s.key !== "");
		const blank = view.slices.find((s) => s.key === "");
		const total = view.named ?? named.length;
		const share =
			blank && summary.cost > 0
				? ` (${total} named, ${money(blank.cost)} unattributed, ` +
					`${((blank.cost / summary.cost) * 100).toFixed(0)}%)`
				: "";
		lines.push("", `Fan-out by ${view.dimension}${share}`);
		for (const s of named) {
			lines.push(
				`  ${elide(s.key).padEnd(KEY_WIDTH)} ${money(s.cost).padStart(9)}` +
					`  ${s.runs.toLocaleString().padStart(9)} runs`,
			);
		}
		if (total > named.length) {
			lines.push(`  ${total - named.length} more, ask for a larger limit`);
		}
	} else if (view?.unrecorded) {
		lines.push(
			`  not split by ${view.dimension}: the run store does not record it`,
		);
	}
	return lines.join("\n");
}

/**
 * Render arguments asked more than once inside one session, heaviest
 * first by the bytes the repeats re-admitted. The header totals every
 * repeat, not only the rows the limit shows, and splits them into
 * rework, where nothing checked the work between the two asks, and
 * appraisal, where a verifier did. Only rework is waste. No cost figure:
 * chars are not dollars, and the point is the repetition, not a price.
 */
export function formatRepeats(
	repeats: readonly RepeatedCall[],
	limit: number,
): string {
	if (repeats.length === 0) {
		return "no repeated tool calls found within a session";
	}
	const sum = (pick: (r: RepeatedCall) => number) =>
		repeats.reduce((total, r) => total + pick(r), 0);
	const chars = (n: number) => `${(n / 1e6).toFixed(1)}M chars`;
	const lines = [
		`Repeated tool calls: ${sum((r) => r.repeated).toLocaleString()} repeats ` +
			`of ${repeats.length.toLocaleString()} argument sets, ` +
			`${chars(sum((r) => r.repeatedChars))} re-admitted`,
		`  rework    ${sum((r) => r.rework).toLocaleString()} ` +
			`(${chars(sum((r) => r.reworkChars))}): nothing checked the work ` +
			"between the two asks",
		`  appraisal ${sum((r) => r.appraisal).toLocaleString()} ` +
			`(${chars(sum((r) => r.appraisalChars))}): a verifier ran between ` +
			"them, so the work was being checked",
	];
	const shown = repeats.slice(0, limit);
	for (const r of shown) {
		lines.push(
			`  ${r.name.padEnd(12)} asked ${String(r.asked).padStart(4)} times` +
				`  ${String(r.repeated).padStart(4)} repeats` +
				` (${r.rework} rework, ${r.appraisal} appraisal)` +
				`  ${(r.repeatedChars / 1e6).toFixed(1)}M chars re-admitted`,
		);
	}
	if (repeats.length > shown.length) {
		lines.push(
			`  ${(repeats.length - shown.length).toLocaleString()} more, ask for a larger limit`,
		);
	}
	return lines.join("\n");
}

/**
 * Render dropped calls asked again afterward: the earlier answer was
 * discarded by a compaction and the same question was put a second
 * time. Leads with the rate against the drops it could have been out
 * of, since that rate is the pruner error this measures, then breaks it
 * down by tool, heaviest first by what the re-asks re-admitted.
 */
export function formatRegret(report: RegretReport): string {
	const { inScope, reAsked } = report;
	if (reAsked.length === 0) {
		return (
			`no regret found: none of ${inScope.toLocaleString()} dropped ` +
			"calls was asked again"
		);
	}
	const byTool = new Map<string, { asked: number; chars: number }>();
	let chars = 0;
	for (const r of reAsked) {
		const tool = byTool.get(r.name) ?? { asked: 0, chars: 0 };
		tool.asked += 1;
		tool.chars += r.resultChars ?? 0;
		chars += r.resultChars ?? 0;
		byTool.set(r.name, tool);
	}
	const rate = inScope > 0 ? (reAsked.length / inScope) * 100 : 0;
	const head =
		`Regret: ${reAsked.length.toLocaleString()} of ${inScope.toLocaleString()} ` +
		`dropped calls asked again (${rate.toFixed(1)}%), ` +
		`re-admitting ${(chars / 1e6).toFixed(1)}M chars`;
	const rows = [...byTool.entries()]
		.sort(([, a], [, b]) => b.chars - a.chars)
		.map(
			([name, tool]) =>
				`  ${name.padEnd(28)} ${tool.asked.toLocaleString().padStart(6)} re-asked` +
				`  ${(tool.chars / 1e6).toFixed(1)}M chars`,
		);
	return [head, ...rows].join("\n");
}

/**
 * Render each verifier kind's pass rate, worst first: the kind most
 * worth attention belongs at the top, not buried under the healthy
 * ones. Unknown outcomes are named apart from failures, since a call
 * whose result never arrived is not the same claim as one that failed.
 */
export function formatVerifierOutcomes(
	outcomes: readonly VerifierOutcome[],
): string {
	if (outcomes.length === 0) {
		return "nothing verified: no test, build, typecheck or lint call seen";
	}
	const rate = (o: VerifierOutcome) =>
		o.passed + o.failed > 0 ? o.passed / (o.passed + o.failed) : 1;
	const rows = [...outcomes]
		.sort((a, b) => rate(a) - rate(b))
		.map((o) => {
			const decided = o.passed + o.failed;
			const pct = decided > 0 ? Math.round((o.passed / decided) * 100) : 0;
			const unknown = o.unknown > 0 ? `  ${o.unknown} unknown` : "";
			return (
				`  ${o.kind.padEnd(10)} ${o.passed} passed, ${o.failed} failed ` +
				`(${pct}%)${unknown}`
			);
		});
	return ["Verifier outcomes", ...rows].join("\n");
}

/**
 * Render how real compactions compare against the payback test: a
 * count evaluable out of the total, and how many the test would also
 * have fired against how many it would have declined.
 */
export function formatPaybackReplay(replay: PaybackReplay): string {
	if (replay.compactions === 0) {
		return "no compactions recorded yet to replay the payback test against";
	}
	const lines = [
		`${replay.evaluable} of ${replay.compactions} compactions evaluable`,
		`  ${replay.agreed} the test would also have fired, ` +
			`${replay.disagreed} declined`,
	];
	if (replay.evaluable < replay.compactions) {
		const skipped = replay.compactions - replay.evaluable;
		lines.push(
			`  ${skipped} skipped: no turn followed, or the model has no ` +
				"derivable rate yet",
		);
	}
	return lines.join("\n");
}

/** Say what an index pass read and what it was able to skip. */
export function formatIndexOutcome(outcome: IndexOutcome): string {
	const parts = [
		`indexed ${outcome.scanned} of ${outcome.files} logs in ` +
			`${outcome.seconds.toFixed(0)}s`,
	];
	if (outcome.skipped > 0) {
		parts.push(`${outcome.skipped} unchanged since the last pass`);
	}
	parts.push(
		`${outcome.lines.toLocaleString()} lines, ` +
			`${outcome.inserted.toLocaleString()} new turns, ` +
			`${outcome.duplicates.toLocaleString()} already held, ` +
			`${outcome.insertedCalls.toLocaleString()} new calls, ` +
			`${outcome.insertedDropped.toLocaleString()} dropped by a compaction`,
	);
	if (outcome.unparseable > 0) {
		parts.push(`${outcome.unparseable} lines unreadable`);
	}
	return parts.join("; ");
}
