/**
 * Declared, called: each tool a session declared as it started, held
 * against whether it called it in the last day, for the daily measure.
 *
 * Every turn re-reads every declaration in the prefix, so a tool a
 * session never calls costs its whole declaration on each of that
 * session's turns. Pricing that at each session's own cache-read rate
 * says which tools are worth loading on demand instead, and lets a PR
 * that defers them show its saving the next day. A session's
 * declarations come from the first system message of its log, as the
 * audit's always-on context reads them; its turns and calls come from
 * the ledger, counted in `declared-called.sql`, a row a session.
 */

import { sqlFile } from "../lib/core/internal/sqlite/sql-file.ts";
import type { StandingPrompt } from "../extensions/spend-workflow/standing.ts";
import type { LedgerQuery } from "./one-call.ts";

/** One tool's declarations and calls over the last day. */
export interface ToolWeight {
	readonly tool: string;
	/** Sessions that declared it as they started and worked that day. */
	readonly sessions: number;
	/** Its declaration's median size in characters. */
	readonly chars: number;
	/** Of those, the sessions that called it. */
	readonly calledIn: number;
	readonly calls: number;
	/** What re-reading it cost in the sessions that never called it. */
	readonly unusedCost: number;
}

/** What the measure says about declared tools against called ones. */
export interface DeclaredCalledReport {
	/** Sessions with a declaration read and a turn in the last day. */
	readonly sessions: number;
	/** Their median characters of declarations. */
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

/** One session's day in the ledger. */
interface SessionDay {
	readonly turns: number;
	/** Dollars a cache-read token cost this session. */
	readonly price: number;
	readonly calls: ReadonlyMap<string, number>;
}

/** Hold each session's declared tools against its calls of the day before `now`. */
export async function declaredCalled(
	prompts: readonly StandingPrompt[],
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
	const days = new Map(
		rows.map((row) => [uuidOf(String(row.session)), dayOf(row)]),
	);
	const weights = new Map<
		string,
		{ sessions: number; sizes: number[]; calledIn: number; calls: number; unusedCost: number }
	>();
	const declared: number[] = [];
	for (const prompt of prompts) {
		const day = days.get(prompt.session);
		if (day === undefined) continue;
		declared.push(prompt.pieces.declarations ?? 0);
		for (const [tool, size] of Object.entries(prompt.byTool)) {
			const weight = weights.get(tool) ?? {
				sessions: 0,
				sizes: [],
				calledIn: 0,
				calls: 0,
				unusedCost: 0,
			};
			const calls = day.calls.get(tool) ?? 0;
			weight.sessions += 1;
			weight.sizes.push(size);
			weight.calls += calls;
			if (calls > 0) weight.calledIn += 1;
			else weight.unusedCost += (size / CHARS_PER_TOKEN) * day.turns * day.price;
			weights.set(tool, weight);
		}
	}
	const tools = [...weights]
		.map(([tool, weight]) => ({
			tool,
			sessions: weight.sessions,
			chars: median(weight.sizes),
			calledIn: weight.calledIn,
			calls: weight.calls,
			unusedCost: weight.unusedCost,
		}))
		.sort((a, b) => b.unusedCost - a.unusedCost || a.tool.localeCompare(b.tool));
	return {
		sessions: declared.length,
		medianDeclared: median(declared),
		unusedCost: tools.reduce((sum, tool) => sum + tool.unusedCost, 0),
		tools: tools.slice(0, TOOLS_SHOWN),
	};
}

/** The measure's section on declared tools against called ones. */
export function formatDeclaredCalled(report: DeclaredCalledReport): string {
	const lines = ["## Declared, Called", ""];
	if (report.sessions === 0) {
		lines.push("No session with a readable start worked in the last day.", "");
		return lines.join("\n");
	}
	lines.push(
		`${report.sessions} sessions worked in the last day, starting with a median of ${Math.round(report.medianDeclared / THOUSAND)}k characters of tool declarations. Re-reading the declarations of tools a session never called cost about ${dollars(report.unusedCost)} over the day, at each session's cache-read price and four characters a token.`,
		"",
		"The tools whose unused declarations cost most, where loading on demand would save:",
		"",
		"| Tool | Declared in | Characters | Called in | Calls | Unused reads |",
		"|---|---|---|---|---|---|",
		...report.tools.map(
			(tool) =>
				`| ${tool.tool} | ${tool.sessions} | ${tool.chars.toLocaleString("en-CA")} | ${tool.calledIn} | ${tool.calls} | ${dollars(tool.unusedCost)} |`,
		),
		"",
	);
	return lines.join("\n");
}

/** A ledger row as the day of one session. */
function dayOf(row: Record<string, unknown>): SessionDay {
	const tokens = count(row.readTokens);
	const calls = new Map<string, number>();
	for (const pair of String(row.called ?? "").split(",")) {
		const at = pair.lastIndexOf("=");
		if (at > 0) calls.set(pair.slice(0, at), count(pair.slice(at + 1)));
	}
	return {
		turns: count(row.turns),
		price: tokens === 0 ? 0 : count(row.readCost) / tokens,
		calls,
	};
}

/** The session's id from its log's name, `<started>_<id>.jsonl`. */
function uuidOf(file: string): string {
	return file.replace(/\.jsonl$/, "").split("_").at(-1) ?? file;
}

/** A query file without its leading comment, since the ledger takes only a statement that opens with SELECT or WITH. */
function statement(text: string): string {
	return text.replace(/^(?:--.*\n)+/, "");
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function dollars(value: number): string {
	return `$${value.toFixed(2)}`;
}

/** A number from a row; what isn't one reads as none. */
function count(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}
