/**
 * Declared, called: each tool sessions held over the last day, against
 * whether they called it, for the daily measure.
 *
 * Every turn re-reads every declaration in the prefix, so a tool a
 * session never calls costs its whole declaration on each turn it was
 * held. Pricing that at each session's own cache-read rate says which
 * tools are worth loading on demand instead, and lets a PR that defers
 * them show its saving the next day. What a session held at each turn
 * is the fold of its system messages, which the ledger keeps tool by
 * tool (`declarations`), so a session that reloaded onto other tools is
 * priced by what it held then, not what it started with. Its turns and
 * calls come from the ledger too, all counted in `declared-called.sql`.
 *
 * Every figure is a floor. A script's calls and the tool each gateway
 * call ran count under those tools, from `inner_calls`. A session that
 * ran a script with none of its calls held may have called any tool
 * through it, so it is counted apart and never priced. A session whose
 * log last grew before the ledger kept declarations isn't counted at
 * all, and a rewrite of the prefix pays the dearer write rate, which
 * this leaves out.
 */

import { sqlFile } from "../lib/core/internal/sqlite/sql-file.ts";
import type { LedgerQuery } from "./one-call.ts";

/** One tool's declarations and calls over the last day. */
export interface ToolWeight {
	readonly tool: string;
	/** Sessions that held it during a turn of the day. */
	readonly sessions: number;
	/** Its declaration's median size in characters, as each last held it. */
	readonly chars: number;
	/** Of those, the sessions that called it. */
	readonly calledIn: number;
	readonly calls: number;
	/**
	 * Sessions that didn't call it but ran a script whose calls the
	 * ledger doesn't hold, which may have: their reads of it are left out
	 * of `unusedCost`.
	 */
	readonly scripted: number;
	/** What re-reading it cost in the sessions that never called it. */
	readonly unusedCost: number;
}

/** What the measure says about declared tools against called ones. */
export interface DeclaredCalledReport {
	/** Sessions with declarations held and a turn in the last day. */
	readonly sessions: number;
	/** Their median characters of declarations held, a turn. */
	readonly medianDeclared: number;
	/** What every declaration a session never called cost to re-read. */
	readonly unusedCost: number;
	/** The dearest unused tools, most first. */
	readonly tools: readonly ToolWeight[];
}

const DAY_MS = 86_400_000;
const TOOLS_SHOWN = 15;
/** Characters a token, as pi estimates them. */
const CHARS_PER_TOKEN = 4;
const THOUSAND = 1_000;
const HALF = 2;

/** Hold each tool sessions declared against their calls of the day before `now`. */
export async function declaredCalled(
	query: LedgerQuery,
	now: number,
): Promise<DeclaredCalledReport> {
	const rows = await query(
		statement(
			sqlFile(new URL("./declared-called.sql", import.meta.url), {
				since_ms: now - DAY_MS,
				until_ms: now,
			}),
		),
	);
	const summary = rows.find((row) => row.kind === "sessions");
	const tools = rows
		.filter((row) => row.kind === "tool")
		.map((row) => ({
			tool: String(row.tool),
			sessions: count(row.sessions),
			chars: median(sizesOf(row.sizes)),
			calledIn: count(row.calledIn),
			calls: count(row.calls),
			scripted: count(row.scripted),
			unusedCost: count(row.unusedCharCost) / CHARS_PER_TOKEN,
		}))
		.sort(byUnusedCost);
	return {
		sessions: count(summary?.sessions),
		medianDeclared: median(sizesOf(summary?.sizes)),
		unusedCost: tools.reduce((sum, tool) => sum + tool.unusedCost, 0),
		tools: tools.slice(0, TOOLS_SHOWN),
	};
}

/** The measure's section on declared tools against called ones. */
export function formatDeclaredCalled(report: DeclaredCalledReport): string {
	const lines = ["## Declared, Called", ""];
	if (report.sessions === 0) {
		lines.push(
			"No session with its declarations in the ledger worked in the last day.",
			"",
		);
		return lines.join("\n");
	}
	lines.push(
		`${report.sessions} sessions worked in the last day, holding a median of ${Math.round(report.medianDeclared / THOUSAND)}k characters of tool declarations a turn. Re-reading the declarations of tools a session never called cost at least ${dollars(report.unusedCost)} over the day, for the turns each was held, at each session's cache-read price and four characters a token.`,
		"",
		"A call made inside a codemode script counts under the tool it ran, and a gateway call under the gateway's runner. A session that ran a script whose calls the ledger doesn't hold is counted under Maybe in a script and left out of the price. Rewriting the prefix pays the dearer write rate, which isn't counted either. The tools whose unused declarations cost most, where loading on demand would save:",
		"",
		"| Tool | Declared in | Characters | Called in | Calls | Maybe in a script | Unused reads |",
		"|---|---|---|---|---|---|---|",
		...report.tools.map(
			(tool) =>
				`| ${tool.tool} | ${tool.sessions} | ${tool.chars.toLocaleString("en-CA")} | ${tool.calledIn} | ${tool.calls} | ${tool.scripted} | ${dollars(tool.unusedCost)} |`,
		),
		"",
	);
	return lines.join("\n");
}

/** The sizes a row joined with commas. */
function sizesOf(value: unknown): number[] {
	if (value === null || value === undefined) return [];
	return String(value)
		.split(",")
		.map(count)
		.filter((size) => size > 0);
}

/** Dearest unused first, then by name. */
function byUnusedCost(a: ToolWeight, b: ToolWeight): number {
	return b.unusedCost - a.unusedCost || a.tool.localeCompare(b.tool);
}

/** A query file without its leading comment, since the ledger takes only a statement that opens with SELECT or WITH. */
function statement(text: string): string {
	return text.replace(/^(?:--.*\n)+/, "");
}

/** The middle value, the mean of the two middle ones for an even count, or 0 for none. */
function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const upper = sorted[Math.floor(sorted.length / HALF)] ?? 0;
	if (sorted.length % HALF === 1) return upper;
	const lower = sorted[sorted.length / HALF - 1] ?? upper;
	return (lower + upper) / HALF;
}

function dollars(value: number): string {
	return `$${value.toFixed(2)}`;
}

/** A number from a row; what isn't one reads as none. */
function count(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}
