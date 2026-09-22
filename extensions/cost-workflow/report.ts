import type {
	CostSlice,
	LedgerTotal,
	Regret,
	RepeatedCall,
} from "@jitsusama/agentic-harness.core/observability";

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
 * Render arguments asked more than once inside one session, heaviest
 * first by the bytes the repeats re-admitted. No cost figure: chars are
 * not dollars, and the point is the repetition, not a price on it.
 */
export function formatRepeats(repeats: readonly RepeatedCall[]): string {
	if (repeats.length === 0) {
		return "no repeated tool calls found within a session";
	}
	const rows = repeats.map(
		(r) =>
			`  ${r.name.padEnd(12)} asked ${String(r.asked).padStart(4)} times` +
			`  ${String(r.repeated).padStart(4)} repeats` +
			`  ${(r.repeatedChars / 1e6).toFixed(1)}M chars re-admitted`,
	);
	return [`Repeated tool calls (${repeats.length})`, ...rows].join("\n");
}

/**
 * Render dropped calls asked again afterward: the earlier answer was
 * discarded by a compaction and the same question was put a second
 * time. Grouped by tool and arguments, heaviest by how many times it
 * happened, since one dropped call can be re-asked more than once.
 */
export function formatRegret(regret: readonly Regret[]): string {
	if (regret.length === 0) {
		return "no regret found: nothing dropped by a compaction was asked again";
	}
	const byArgs = new Map<
		string,
		{ name: string; times: number; chars: number }
	>();
	for (const r of regret) {
		const existing = byArgs.get(r.argsDigest) ?? {
			name: r.name,
			times: 0,
			chars: 0,
		};
		existing.times += 1;
		existing.chars += r.resultChars ?? 0;
		byArgs.set(r.argsDigest, existing);
	}
	const rows = [...byArgs.values()]
		.sort((a, b) => b.chars - a.chars)
		.map(
			(r) =>
				`  ${r.name.padEnd(12)} re-fetched ${String(r.times).padStart(4)} ` +
				`times after being dropped  ${(r.chars / 1e6).toFixed(1)}M chars`,
		);
	return [`Regret (${byArgs.size} distinct questions)`, ...rows].join("\n");
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
