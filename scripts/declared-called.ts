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
 *
 * Every figure is a floor. The ledger holds a log's own tool calls, not
 * those a codemode script or the gateway's runner makes, so a session
 * that ran either may have called any tool through it: such sessions
 * are counted apart and never priced. Declarations are read as each
 * session started, and a rewrite of the prefix pays the dearer write
 * rate, which this leaves out.
 */

import type { StandingPrompt } from "../extensions/spend-workflow/standing.ts";
import { sqlFile } from "../lib/core/internal/sqlite/sql-file.ts";
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
	/**
	 * Sessions that didn't call it but ran a script, which may have: their
	 * reads of it are left out of `unusedCost`.
	 */
	readonly scripted: number;
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
const HALF = 2;
/** Tools whose calls run other tools, which the ledger doesn't see. */
const SCRIPTING = ["codemode", "tool_gateway_run_tool"];

/** A tool's running count while the sessions are read. */
interface Tally {
	sessions: number;
	sizes: number[];
	calledIn: number;
	calls: number;
	scripted: number;
	unusedCost: number;
}

/** One session's day in the ledger. */
interface SessionDay {
	readonly turns: number;
	/** Dollars a cache-read token cost this session. */
	readonly price: number;
	readonly calls: ReadonlyMap<string, number>;
	/** Whether it ran a script, whose own calls the ledger doesn't hold. */
	readonly scripted: boolean;
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
	const weights = new Map<string, Tally>();
	const declared: number[] = [];
	for (const prompt of prompts) {
		const day = days.get(prompt.session);
		if (day === undefined) continue;
		declared.push(prompt.pieces.declarations ?? 0);
		for (const [tool, size] of Object.entries(prompt.byTool)) {
			const weight = weights.get(tool) ?? emptyTally();
			addSession(weight, size, day.calls.get(tool) ?? 0, day);
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
			scripted: weight.scripted,
			unusedCost: weight.unusedCost,
		}))
		.sort(byUnusedCost);
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
		`${report.sessions} sessions worked in the last day, starting with a median of ${Math.round(report.medianDeclared / THOUSAND)}k characters of tool declarations, as each started. Re-reading the declarations of tools a session never called cost at least ${dollars(report.unusedCost)} over the day, at each session's cache-read price and four characters a token.`,
		"",
		"A call made inside a codemode script or through the gateway's runner isn't in the ledger, so a session that ran one is counted under Maybe in a script and left out of the price. Rewriting the prefix pays the dearer write rate, which isn't counted either. The tools whose unused declarations cost most, where loading on demand would save:",
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
		scripted: SCRIPTING.some((tool) => calls.has(tool)),
	};
}

function emptyTally(): Tally {
	return {
		sessions: 0,
		sizes: [],
		calledIn: 0,
		calls: 0,
		scripted: 0,
		unusedCost: 0,
	};
}

/** Add one session's declaration of a tool, `size` characters, called `calls` times. */
function addSession(
	weight: Tally,
	size: number,
	calls: number,
	day: SessionDay,
): void {
	weight.sessions += 1;
	weight.sizes.push(size);
	weight.calls += calls;
	if (calls > 0) {
		weight.calledIn += 1;
	} else if (day.scripted) {
		weight.scripted += 1;
	} else {
		weight.unusedCost += (size / CHARS_PER_TOKEN) * day.turns * day.price;
	}
}

/** The session's id from its log's name, `<started>_<id>.jsonl`. */
function uuidOf(file: string): string {
	const name = file.replace(/\.jsonl$/, "");
	return name.slice(name.lastIndexOf("_") + 1);
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
