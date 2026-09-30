/**
 * Cost Workflow extension.
 *
 * The one place in this package that reasons about money. Cost is
 * derived from the session logs pi already writes rather than recorded a
 * second time, so there is a single writer of the truth and the ledger
 * can be rebuilt from scratch whenever its shape changes.
 *
 * The `cost` tool indexes those logs into a content-addressed store and
 * answers what was spent, grouped by repo, quest, model, day, session,
 * kind or thinking level. Fan-out is read from the run store beside it,
 * since subagents write no session log for the ledger to index.
 * Indexing is incremental: an append-only log that has not grown is not
 * read again, so a routine pass costs seconds rather than the minute a
 * full corpus takes.
 *
 * Every answer states its own coverage. Turns that carried no usage are
 * counted but not priced, and spend whose session named no repo or quest
 * stays a visible slice, because a share computed against a total that
 * quietly excluded it is worse than no share at all.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type {
	CostSlice,
	QueryAnswer,
} from "@jitsusama/agentic-harness.core/observability";
import {
	type CostDimension,
	type LedgerReader,
	type LedgerTotal,
	openLedgerReader,
	openRunStore,
	openTurnStore,
	type RunStore,
	registerRunRecorder,
	type TurnStore,
} from "@jitsusama/agentic-harness.core/observability";
import {
	citeListing,
	openSessionStore,
} from "@jitsusama/agentic-harness.core/result";
import { Type } from "@sinclair/typebox";
import { medianOf } from "../../lib/internal/cost-meter/index.ts";
import { packageStateDir } from "../../lib/internal/package-state-dir.ts";
import { LEDGER_SCOPE } from "../../lib/ledger/index.ts";
import { fanOutView, summarizeFanOut } from "./fanout.ts";
import { indexSessionLogs } from "./indexer.ts";
import {
	formatFanOut,
	formatIndexOutcome,
	formatPaybackReplay,
	formatQueryAnswer,
	formatRegret,
	formatRepeats,
	formatSlices,
	formatTotal,
	formatVerifierOutcomes,
	type IndexOutcome,
} from "./report.ts";

/** Rows of a query answer shown before the rest is left to the store. */
const QUERY_ROWS_SHOWN = 40;

/** Dimensions the tool will group by, in the ledger's own vocabulary. */
const DIMENSIONS: readonly CostDimension[] = [
	"repo",
	"quest",
	"model",
	"day",
	"session",
	"kind",
	"thinking",
];

/** Human wording for each dimension's heading. */
const HEADINGS: Record<CostDimension, string> = {
	repo: "Cost by repo",
	quest: "Cost by quest",
	model: "Cost by model",
	day: "Cost by day",
	session: "Cost by session",
	kind: "Cost by kind",
	thinking: "Cost by thinking level",
};

/**
 * What `query` is told about the ledger, so a question can be asked of it
 * without first asking what is in it. The views are defined in the
 * ledger itself; this names them and what they are for.
 */
const QUERY_GUIDE =
	"Run one read-only SQL SELECT against the ledger instead of a spend " +
	"report, and answer with its rows. Views: turn_facts (one row per " +
	"billed turn: timestamp, day, kind 'assistant' or 'compaction', model, " +
	"thinking_level, context, tokens_* and cost_* columns, cost, " +
	"preceded_by, gap_ms, new_tokens, stop_reason, thinking_chars, " +
	"text_chars, run_id, run_turn, repo, quest); misses (turn_facts rows " +
	"whose cache write ran past what was new, with excess_tokens, " +
	"excess_cost and cause); cycles (one per compaction: turns, cost, " +
	"context_start, context_end, closed); runs (one per typed message: " +
	"turns, compactions, cost, started_at, ended_at); compaction_moments " +
	"(written, summariser, summary_ms, waited_ms, summary_chars, " +
	"aborted_request, resumed, since_typed_ms, turns_into_run, " +
	"resume_ms). Tables: turns, tool_calls, dropped_calls, sessions. " +
	"SELECT name, sql FROM sqlite_master shows every definition. " +
	"Timestamps are ISO 8601 strings, so compare them as text. Costs are " +
	"at the prices pi put on each request. A query past 5,000 rows is " +
	"refused; aggregate it or add a LIMIT.";

interface CostDetails {
	readonly ok: boolean;
	readonly total?: LedgerTotal;
	readonly index?: IndexOutcome;
}

/**
 * Published whenever the figures move. The status line subscribes and
 * lays them out; this extension never paints, because a brain that
 * paints and a widget that prices are how a status line comes to
 * disagree with itself.
 */
export const COST_READING = "cost:reading";

/**
 * How many recent turns the marginal rate is taken over. Long enough to
 * shrug off one cold-cache turn, short enough to move when the context
 * does.
 */
const MARGINAL_WINDOW = 20;

/** Cost of an assistant turn, or zero for anything else. */
function assistantCost(message: { role: string }): number {
	if (message.role === "assistant" && "usage" in message) {
		return (message as AssistantMessage).usage.cost.total;
	}
	return 0;
}

export default function costWorkflow(pi: ExtensionAPI) {
	let store: TurnStore | null = null;
	let reader: LedgerReader | null = null;
	let ledgerPath = "";
	let watermarks = "";
	let unregisterRuns: (() => void) | null = null;
	const recentTurns: number[] = [];
	// What this session has spent. Fan-out is added here rather than
	// shown separately, because it is the same money: a council round
	// costs what it costs whether or not the parent did the talking.
	let sessionSpend = 0;

	const publish = (): void => {
		pi.events.emit(COST_READING, {
			session: sessionSpend,
			marginal: medianOf(recentTurns),
		});
	};

	/** Take one turn's cost into the total and into the rate's window. */
	const observeTurn = (cost: number): void => {
		if (cost <= 0) return;
		sessionSpend += cost;
		recentTurns.push(cost);
		if (recentTurns.length > MARGINAL_WINDOW) recentTurns.shift();
	};

	// The run store, read for fan-out. Subagents and review rounds write
	// no session log the ledger indexes, so without it the total is the
	// main loop alone and does not say so.
	let runs: RunStore | undefined;
	const openRuns = async (): Promise<RunStore> => {
		runs ??= await openRunStore(
			join(packageStateDir("observability"), "runs.db"),
		);
		return runs;
	};

	const open = async (): Promise<TurnStore> => {
		if (store) return store;
		const dir = packageStateDir("observability");
		mkdirSync(dir, { recursive: true });
		watermarks = join(dir, "ledger-watermarks.json");
		ledgerPath = join(dir, "ledger.db");
		store = await openTurnStore(ledgerPath);
		return store;
	};

	// A second connection, opened read-only, so no query can write
	// whatever it says. Opened after the store, which makes the views.
	const openReader = async (): Promise<LedgerReader> => {
		await open();
		reader ??= await openLedgerReader(ledgerPath);
		return reader;
	};

	pi.on("message_end", async (event) => {
		observeTurn(assistantCost(event.message));
		publish();
	});

	pi.on("session_start", async (_event, ctx) => {
		// Replay the branch rather than starting from zero. A reload or a
		// resumed session has already spent money, and a total that resets
		// to nothing is worse than no total: it reads as a cheap session.
		sessionSpend = 0;
		recentTurns.length = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") observeTurn(assistantCost(entry.message));
		}
		if (!unregisterRuns) {
			// Fan-out lands in the session total but never in the rate: a
			// council round is not a turn, and letting it set the marginal
			// figure would say the next turn costs a hundred dollars.
			unregisterRuns = registerRunRecorder((record) => {
				// An unmetered run adds nothing because nothing is known, not
				// because it was free. The total is then a lower bound, which
				// is the honest reading of a figure missing a term.
				sessionSpend += record.cost?.total ?? 0;
				publish();
			});
		}
		publish();
	});

	pi.on("session_shutdown", async () => {
		unregisterRuns?.();
		unregisterRuns = null;
		const closingReader = reader;
		reader = null;
		if (closingReader) {
			try {
				await closingReader.close();
			} catch {
				// A read-only connection holds nothing to lose; closing it is
				// best-effort at shutdown like the store's.
			}
		}
		const closing = store;
		store = null;
		if (closing) {
			try {
				await closing.close();
			} catch {
				// Closing a ledger is best-effort at shutdown; the next
				// session reopens it and re-indexes what it missed.
			}
		}
	});

	pi.registerTool({
		name: "cost",
		label: "Cost",
		description:
			"Report what pi has actually cost, from the session logs it " +
			"already writes, with subagent fan-out from the run store beside " +
			"it. Group by repo, quest, model, day, session, kind or thinking " +
			"level, or omit a dimension for the overall total. Indexing is " +
			"incremental and runs automatically before a report; pass " +
			"reindex to force a pass without reporting. Every answer states " +
			"its coverage, including turns that carried no usage and spend " +
			"whose session named no repo or quest. For any other question " +
			"about spend, cache misses, compaction cycles, runs or the moment " +
			"of a compaction, pass query with one SQL SELECT over the ledger's " +
			"views.",
		promptSnippet:
			"When asked what something cost, what the spend is, or where the " +
			"money went, read it from the ledger with the cost tool rather " +
			"than estimating.",
		parameters: Type.Object({
			by: Type.Optional(
				Type.Union(
					DIMENSIONS.map((d) => Type.Literal(d)),
					{
						description:
							"Group spend by this dimension. Omit for the overall total.",
					},
				),
			),
			limit: Type.Optional(
				Type.Number({
					description:
						"How many slices, or query rows, to show. Defaults to 12, and " +
						"to 40 for a query.",
				}),
			),
			query: Type.Optional(Type.String({ description: QUERY_GUIDE })),
			reindex: Type.Optional(
				Type.Boolean({
					description:
						"Run an index pass and report what it read, without a spend report.",
				}),
			),
			repeats: Type.Optional(
				Type.Boolean({
					description:
						"Report retrieval calls whose arguments were asked more than " +
						"once within a session with no write to their file in between, " +
						"heaviest first, instead of a spend report. Each is a question " +
						"the session's own context could already answer. Splits them " +
						"into rework, with nothing checking the work between the two " +
						"asks, and appraisal, where a verifier ran between: only rework " +
						"is waste.",
				}),
			),
			regret: Type.Optional(
				Type.Boolean({
					description:
						"Report retrieval calls a compaction dropped that were asked " +
						"again afterward, as a rate over every dropped retrieval call, " +
						"instead of a spend report. Each is a case of the context " +
						"having to re-fetch what it had just lost.",
				}),
			),
			verify: Type.Optional(
				Type.Boolean({
					description:
						"Report how test, build, typecheck and lint calls fared, worst " +
						"pass rate first, instead of a spend report.",
				}),
			),
			payback: Type.Optional(
				Type.Boolean({
					description:
						"Report how real compactions compare against the payback " +
						"test (would summarising have been worth what it cost to " +
						"write), instead of a spend report.",
				}),
			),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<CostDetails>> {
			const opened = await open();
			const index = await indexSessionLogs(opened, watermarks);

			if (params.reindex) {
				return {
					content: [{ type: "text", text: formatIndexOutcome(index) }],
					details: { ok: true, index },
				};
			}

			if (params.query !== undefined) {
				let answer: QueryAnswer;
				try {
					answer = await (await openReader()).query(params.query);
				} catch (error) {
					// A refused or malformed query is the caller's to fix, so it is
					// answered with what SQLite or the guard said, not thrown.
					const reason = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: "text", text: `Query refused: ${reason}` }],
						details: { ok: false, index },
					};
				}
				const limit = params.limit ?? QUERY_ROWS_SHOWN;
				return {
					content: [
						{
							type: "text",
							text: citeListing(openSessionStore(), {
								view: formatQueryAnswer(answer, limit),
								records: answer.rows,
								unit: "rows",
								elided: answer.rows.length > limit,
								narrowing:
									"Query the stored rows, or aggregate in SQL and ask again.",
							}),
						},
					],
					details: { ok: true, index },
				};
			}

			if (params.repeats) {
				const repeats = await opened.repeatedCalls(LEDGER_SCOPE);
				return {
					content: [
						{
							type: "text",
							text: citeListing(openSessionStore(), {
								view: formatRepeats(repeats, params.limit ?? 12),
								records: repeats,
								unit: "repeats",
								narrowing: "Ask for a larger limit to see more.",
							}),
						},
					],
					details: { ok: true },
				};
			}

			if (params.regret) {
				const regret = await opened.regret(LEDGER_SCOPE);
				return {
					content: [
						{
							type: "text",
							text: citeListing(openSessionStore(), {
								view: formatRegret(regret),
								records: regret.reAsked,
								unit: "regrets",
								narrowing: "Query the stored result for the full list.",
							}),
						},
					],
					details: { ok: true },
				};
			}

			if (params.verify) {
				const outcomes = await opened.verifierOutcomes();
				return {
					content: [{ type: "text", text: formatVerifierOutcomes(outcomes) }],
					details: { ok: true },
				};
			}

			if (params.payback) {
				const replay = await opened.paybackReplay();
				return {
					content: [{ type: "text", text: formatPaybackReplay(replay) }],
					details: { ok: true },
				};
			}

			const total = await opened.total();
			const sections = [formatTotal(total)];
			let slices: readonly CostSlice[] = [];
			if (params.by) {
				slices = await opened.costBy(params.by);
				sections.push(
					formatSlices(HEADINGS[params.by], slices, params.limit ?? 12),
				);
			}
			const fanOut = await (await openRuns()).queryRuns();
			sections.push(
				formatFanOut(
					summarizeFanOut(fanOut),
					fanOutView(
						fanOut,
						params.by,
						params.limit ?? 12,
						await opened.sessions(),
					),
				),
			);
			if (index.scanned > 0) sections.push(formatIndexOutcome(index));
			const view = sections.join("\n\n");

			// Grouping by session yields a slice per log, which is over a
			// thousand rows. The view shows the heaviest few and the rest
			// stays queryable rather than either flooding the answer or
			// disappearing from it.
			return {
				content: [
					{
						type: "text",
						text: citeListing(openSessionStore(), {
							view,
							records: slices,
							unit: "slices",
							narrowing: "Group by a coarser dimension, or lower 'limit'.",
						}),
					},
				],
				details: { ok: true, total, index },
			};
		},
	});
}
