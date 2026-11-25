/**
 * Spend Workflow extension.
 *
 * The one place in this package that reasons about money. Cost is
 * derived from the session logs pi already writes rather than recorded a
 * second time, so there is a single writer of the truth and the ledger
 * can be rebuilt from scratch whenever its shape changes.
 *
 * The `spend` tool indexes those logs into a content-addressed store and
 * answers what was spent, grouped by repo, quest, document, model, day,
 * session, kind or thinking level. Fan-out is read from the run store beside it,
 * since subagents write no session log for the ledger to index.
 * Indexing is incremental: an append-only log that has not grown is not
 * read again, so a routine pass costs seconds rather than the minute a
 * full corpus takes. One still pi on the machine also runs a pass every
 * half hour, and every pass stamps when it ran and whether it failed
 * (`keeper.ts`), so readers outside pi know how current the ledger is.
 *
 * Every answer states its own coverage. Turns that carried no usage are
 * counted but not priced, and spend whose session named no repo or quest
 * stays a visible slice, because a share computed against a total that
 * quietly excluded it is worse than no share at all.
 *
 * The footer says the budget the session spends and how near its
 * allowances stand, and `/budget` says every budget's, with all AI
 * spend in billed dollars (`budget.ts`, `budget-item.ts`), as
 * spend-watch keeps them.
 *
 * Money is not the only cost. `disk` reports what each quest holds on
 * disk and what of it could go now (`disk.ts`), measured on asking and
 * never from the ledger, since disk is a standing amount rather than a
 * flow of turns.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawnExec } from "../../lib/core/exec/index.ts";
import type { CostSlice } from "../../lib/core/observability/index.ts";
import {
	type CostDimension,
	type LedgerReader,
	openLedgerReader,
	openRunStore,
	openTurnStore,
	type RunStore,
	registerRunRecorder,
	type TurnStore,
} from "../../lib/core/observability/index.ts";
import { citeListing } from "../../lib/core/result/listing.ts";
import { openSessionStore } from "../../lib/core/result/location.ts";
import { hosted } from "../../lib/core/session/index.ts";
import { dataDir, stateDir } from "../../lib/internal/paths.ts";
import { processGlobal } from "../../lib/internal/process/process-global.ts";
import { duMeasure } from "../../lib/internal/quest/workspace/footprint.ts";
import { questWorkspacesRoot } from "../../lib/internal/quest/workspace/workspace-root.ts";
import {
	type Carry,
	ROLLOVER_CARRY,
} from "../../lib/internal/session/rollover.ts";
import { onTurnEnd } from "../../lib/internal/session/turn-end.ts";
import { medianOf } from "../../lib/internal/spend/cost-meter/index.ts";
import {
	assistantCost,
	SPEND_CARRY,
	spentOnBranch,
} from "../../lib/internal/spend/session-spend.ts";
import {
	askBill,
	BILL_PERIODS,
	type BillPeriod,
	isBillCut,
} from "../../lib/internal/spend/spend-watch.ts";
import { budgetAsks, registerBudgetItem } from "./budget-item.ts";
import { formatHoldings, measureQuests } from "./disk.ts";
import { fanOutView, summarizeFanOut } from "./fanout.ts";
import { indexSessionLogs } from "./indexer.ts";
import { claimLease, registerKeeper, stampedPass } from "./keeper.ts";
import {
	formatBill,
	formatFanOut,
	formatIndexOutcome,
	formatSlices,
	formatTotal,
	type IndexOutcome,
} from "./report.ts";
import { askedReport, type CostDetails, HELD_ELSEWHERE } from "./reports.ts";
import { noteLoad, recordTurn } from "./resources.ts";
import { recordWhoServed } from "./served.ts";

/** Where each session's per-turn resource figures are kept. */
const resourcesDir = () => join(stateDir("observability"), "resources");

/** The period the bill is asked for when the caller names none. */
const BILL_PERIOD: BillPeriod = "30 days";

/**
 * How long spend-watch may take to answer. It reads its whole history,
 * about 1.3 s on a busy machine, so this only stops one that hangs.
 */
const BILL_TIMEOUT_MS = 20_000;

/** Dimensions the tool will group by, in the ledger's own vocabulary. */
const DIMENSIONS: readonly CostDimension[] = [
	"repo",
	"quest",
	"document",
	"model",
	"day",
	"session",
	"kind",
	"thinking",
];

/**
 * The grouping only spend-watch's bill answers: pi's ledger holds no
 * budget, so asked by budget the answer is the bill's cut alone.
 */
const BUDGET = "budget";

/** A grouping the tool takes: the ledger's, or budget. */
type Grouping = CostDimension | typeof BUDGET;

/** Human wording for each dimension's heading. */
const HEADINGS: Record<CostDimension, string> = {
	repo: "Cost by repo",
	quest: "Cost by quest",
	document: "Cost by document",
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
	"billed turn: timestamp, day, kind 'assistant', 'compaction' or 'side' " +
	"(a model call an extension made off the agent's loop), model, " +
	"thinking_level, context, tokens_* and cost_* columns, cost, " +
	"preceded_by, gap_ms, new_tokens, stop_reason, thinking_chars, " +
	"text_chars, run_id, run_turn, repo, quest, document); misses (turn_facts rows " +
	"whose cache write ran past what was new, with excess_tokens, " +
	"excess_cost and cause); cycles (one per compaction: turns, cost, " +
	"side_cost, context_start, context_end, closed); runs (one per typed message: " +
	"turns, compactions, cost, started_at, ended_at); compaction_moments " +
	"(written, summariser, summary_ms, waited_ms, summary_chars, " +
	"aborted_request, resumed, since_typed_ms, turns_into_run, " +
	"resume_ms). Tables: turns, tool_calls, dropped_calls, sessions. " +
	"SELECT name, sql FROM sqlite_master shows every definition. " +
	"Timestamps are ISO 8601 strings, so compare them as text. Costs are " +
	"at the prices pi put on each request. A query past 5,000 rows is " +
	"refused; aggregate it or add a LIMIT.";

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

/** Why a load that has shut down won't open the ledger again. */
const LEDGER_CLOSED = "The ledger is closed: this session has ended.";

/**
 * spend-watch's bill for a period, drawn as its own section, in the
 * same grouping where it has one; nothing when it isn't installed or
 * doesn't answer, since the ledger's answer stands on its own.
 */
async function quoteBill(
	period: BillPeriod,
	by: Grouping | undefined,
	limit: number,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const exec = spawnExec({
		timeoutMs: BILL_TIMEOUT_MS,
		...(signal ? { signal } : {}),
	});
	const cut = by && isBillCut(by) ? by : undefined;
	const bill = await askBill(exec, period, cut);
	if (!bill) return undefined;
	// Asked for no cut, spend-watch still answers by quest, its own
	// default; the ledger's section beside it is a total, so this is too.
	if (!by) return formatBill({ ...bill, rows: [], notes: [] }, limit);
	return formatBill(bill, limit, cut ? undefined : by);
}

/** Wait for `work` to end, whichever way it ends, when there is any. */
async function settled(work: Promise<unknown> | null): Promise<void> {
	if (work === null) return;
	try {
		await work;
	} catch {
		// Its caller hears how it failed; here it only has to be over.
	}
}

export default function spendWorkflow(pi: ExtensionAPI) {
	// Each conversation load or reload runs this again in the same process,
	// so resource samples can say how many loads its memory has been through.
	noteLoad();
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
		runs ??= await openRunStore(join(stateDir("observability"), "runs.db"));
		return runs;
	};

	// The opening under way, shared for the same reason as a pass: two
	// calls at once each found no store and opened a connection of their
	// own, and the one overwritten was never closed.
	let opening: Promise<TurnStore> | null = null;
	// Fired at shutdown: a pass under way stops at its next log, and
	// nothing opens the ledger again in a load that has closed it.
	const ending = new AbortController();
	const open = async (): Promise<TurnStore> => {
		if (ending.signal.aborted) throw new Error(LEDGER_CLOSED);
		if (store) return store;
		opening ??= (async () => {
			const dir = stateDir("observability");
			mkdirSync(dir, { recursive: true });
			watermarks = join(dir, "ledger-watermarks.json");
			ledgerPath = join(dir, "ledger.db");
			store = await openTurnStore(ledgerPath);
			return store;
		})().finally(() => {
			opening = null;
		});
		return opening;
	};

	// The pass under way, which a call arriving meanwhile shares. Every
	// call indexes first, and two calls at once (parallel tool calls, a
	// codemode script's Promise.all) ran two passes on one connection,
	// where the second's BEGIN lands inside the first's transaction and
	// SQLite refuses it.
	let indexing: ReturnType<typeof indexSessionLogs> | null = null;
	const indexOnce = (
		opened: TurnStore,
		lost: AbortSignal,
	): ReturnType<typeof indexSessionLogs> => {
		indexing ??= indexSessionLogs(
			opened,
			watermarks,
			undefined,
			AbortSignal.any([ending.signal, lost]),
		).finally(() => {
			indexing = null;
		});
		return indexing;
	};

	// The tool's pass: the one under way in this load, shared, or a new
	// one under the keepers' lease. Undefined when a pass elsewhere holds
	// the lease, whose writes the tool would only queue behind.
	const toolPass = async (
		opened: TurnStore,
	): Promise<IndexOutcome | undefined> => {
		const dir = stateDir("observability");
		const lost = new AbortController();
		if (indexing) {
			return stampedPass(dir, "tool", () => indexOnce(opened, lost.signal));
		}
		const release = claimLease(
			dir,
			Date.now(),
			undefined,
			undefined,
			undefined,
			() => lost.abort(),
		);
		if (release === undefined) return undefined;
		try {
			return await stampedPass(dir, "tool", () =>
				indexOnce(opened, lost.signal),
			);
		} finally {
			release();
		}
	};

	registerKeeper(pi, async (lost) => indexOnce(await open(), lost));

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

	// Who served each request, so a cache a failover dropped can be told
	// from one a provider evicted.
	recordWhoServed(pi);

	registerBudgetItem(pi, {
		exec: () => spawnExec({ timeoutMs: BILL_TIMEOUT_MS }),
		listPrice: () => sessionSpend,
		// One ask a minute for the whole process, which a host shares
		// among its conversations.
		asks: processGlobal("agentic-harness.budget-asks", budgetAsks),
	});

	// What the machine did for each turn, which no log records. Only a
	// session with a person at it on plain pi, since a subagent's use
	// already lands in its parent. A host records once for the process.
	onTurnEnd(pi, (_event, ctx) => {
		if (!ctx.hasUI && !hosted()) return;
		const log = ctx.sessionManager.getSessionFile();
		if (!log) return;
		try {
			recordTurn(log, { dir: resourcesDir() });
		} catch {
			// A full disk or a read-only state directory costs this turn's
			// figure, never the turn.
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		// Replay the branch rather than starting from zero. A reload or a
		// resumed session has already spent money, and a total that resets
		// to nothing is worse than no total: it reads as a cheap session.
		sessionSpend = 0;
		recentTurns.length = 0;
		const branch = ctx.sessionManager.getBranch();
		for (const entry of branch) {
			if (entry.type === "message") observeTurn(assistantCost(entry.message));
		}
		// A log rolled over from a larger one, or a hosted conversation
		// holding only its kept entries, starts with the spend it carried,
		// which already holds every turn up to its record.
		sessionSpend = spentOnBranch(branch);
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
			}, ctx);
		}
		publish();
	});

	pi.events.on(ROLLOVER_CARRY, (data) => {
		const carry = data as Partial<Carry> | undefined;
		if (typeof carry?.carried !== "object" || carry.carried === null) return;
		carry.carried[SPEND_CARRY] = { spend: sessionSpend };
	});

	pi.on("session_shutdown", async () => {
		unregisterRuns?.();
		unregisterRuns = null;
		// A pass, or the opening it waits on, may still be under way: a
		// keeper's runs for minutes. Closing under it would end it on a
		// closed handle, so it is told to stop at its next log, keeping
		// what it read, and the close waits for it.
		ending.abort();
		await settled(opening);
		await settled(indexing);
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
		name: "spend",
		// Called in 6 of 77 sessions from 8 October: loaded on demand.
		exposure: "deferred",
		label: "Spend",
		description:
			"Report what pi has actually spent, from the session logs it " +
			"already writes, with subagent fan-out from the run store beside " +
			"it. Group by repo, quest, document, model, day, session, kind or " +
			"thinking level, or omit a dimension for the overall total. Indexing is " +
			"incremental and runs automatically before a report; pass " +
			"reindex to force a pass without reporting. Every answer states " +
			"its coverage, including turns that carried no usage and spend " +
			"whose session named no repo or quest. Its own figures are list " +
			"prices; where spend-watch is installed, a report also quotes " +
			"its bill for a period (30 days unless period is given), in the " +
			"same grouping where it has one. For any other question " +
			"about spend, cache misses, compaction cycles, runs or the moment " +
			"of a compaction, pass query with one SQL SELECT over the ledger's " +
			"views.",
		promptSnippet:
			"When asked what something cost, what the spend is, or where the " +
			"money went, read it from the ledger with the spend tool rather " +
			"than estimating.",
		parameters: Type.Object({
			by: Type.Optional(
				Type.Union(
					[...DIMENSIONS, BUDGET].map((d) => Type.Literal(d)),
					{
						description:
							"Group spend by this dimension. Omit for the overall total. " +
							"budget is answered by spend-watch's bill alone, since the " +
							"ledger doesn't know which budget a turn drew on.",
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
			period: Type.Optional(
				Type.Union(
					BILL_PERIODS.map((p) => Type.Literal(p)),
					{
						description:
							"The period spend-watch's bill is quoted for, where it is " +
							"installed. Defaults to 30 days; the ledger's own figures " +
							"cover every log it holds.",
					},
				),
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
			disk: Type.Optional(
				Type.Boolean({
					description:
						"Report what each quest holds on disk (its scratch folder and the " +
						"trees it made) and how much could go now, heaviest first, " +
						"instead of a spend report. It walks directories at low " +
						"priority, so it can take up to a minute.",
				}),
			),
			resources: Type.Optional(
				Type.Boolean({
					description:
						"Report the CPU time, disk reads and writes and peak memory " +
						"each quest's sessions used, heaviest CPU first, instead of a " +
						"spend report. Counted from the kernel at the end of every " +
						"turn, including the commands and subagents a session ran. " +
						"Shared hosts have separate rows, not per-conversation figures.",
				}),
			),
			audit: Type.Optional(
				Type.Boolean({
					description:
						"Report the last seven days in one digest, held against the " +
						"seven before: spend and what it went on, cache rewrites by " +
						"cause, the always-on context each repository reads on every " +
						"turn piece by piece, and the tools whose calls failed most. " +
						"Start here when asked where the money went or what to fix.",
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
		async execute(
			_toolCallId,
			params,
			signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<CostDetails>> {
			if (params.disk) {
				const holdings = await measureQuests(
					join(dataDir("quest-workflow"), "quests"),
					questWorkspacesRoot(),
					duMeasure(signal ? { signal } : {}),
				);
				return {
					content: [
						{
							type: "text",
							text: citeListing(openSessionStore(ctx), {
								view: formatHoldings(holdings, params.limit ?? 12),
								records: holdings.quests,
								unit: "quests",
								narrowing: "Ask for a larger limit to see more.",
							}),
						},
					],
					details: { ok: true },
				};
			}
			const opened = await open();
			const index = await toolPass(opened);

			if (params.reindex) {
				return {
					content: [
						{
							type: "text",
							text: index ? formatIndexOutcome(index) : HELD_ELSEWHERE,
						},
					],
					details: { ok: true, index },
				};
			}

			// Each report but the total, which says it among its sections.
			const reported = await askedReport(params, {
				opened,
				reader: openReader,
				results: () => openSessionStore(ctx),
				deferred: () =>
					pi
						.getAllTools()
						.filter((tool) => tool.exposure === "deferred")
						.map((tool) => tool.name),
				resourcesDir: resourcesDir(),
				index,
			});
			if (reported) return reported;

			const total = await opened.total();
			const sections = [formatTotal(total)];
			let slices: readonly CostSlice[] = [];
			const dimension = params.by === BUDGET ? undefined : params.by;
			if (params.by === BUDGET) {
				sections.push(
					"The ledger doesn't know which budget a turn drew on; spend-watch's bill below cuts by budget.",
				);
			}
			if (dimension) {
				slices = await opened.costBy(dimension);
				sections.push(
					formatSlices(HEADINGS[dimension], slices, params.limit ?? 12),
				);
			}
			const bill = await quoteBill(
				params.period ?? BILL_PERIOD,
				params.by,
				params.limit ?? 12,
				signal,
			);
			if (bill) sections.push(bill);
			const fanOut = await (await openRuns()).queryRuns();
			sections.push(
				formatFanOut(
					summarizeFanOut(fanOut),
					fanOutView(
						fanOut,
						dimension,
						params.limit ?? 12,
						await opened.sessions(),
					),
				),
			);
			if (index === undefined) sections.push(HELD_ELSEWHERE);
			else if (index.scanned > 0) sections.push(formatIndexOutcome(index));
			const view = sections.join("\n\n");

			// Grouping by session yields a slice per log, which is over a
			// thousand rows. The view shows the heaviest few and the rest
			// stays queryable rather than either flooding the answer or
			// disappearing from it.
			return {
				content: [
					{
						type: "text",
						text: citeListing(openSessionStore(ctx), {
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
