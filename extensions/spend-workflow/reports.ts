/**
 * The spend tool's reports other than the total: resources, audit, a
 * query, repeats, regret, verify and payback. Each reads the ledger as
 * the tool's pass left it, and one read while another pass held the
 * ledger says so first, so a stale figure never reads as a current one.
 */

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {
	LedgerReader,
	LedgerTotal,
	QueryAnswer,
	TurnStore,
} from "../../lib/core/observability/index.ts";
import { citeListing } from "../../lib/core/result/listing.ts";
import type { openSessionStore } from "../../lib/core/result/location.ts";
import { LEDGER_SCOPE } from "../../lib/ledger/index.ts";
import { formatAudit } from "./audit.ts";
import { gatherAudit } from "./audit-input.ts";
import { sessionsDir } from "./indexer.ts";
import {
	formatPaybackReplay,
	formatQueryAnswer,
	formatRegret,
	formatRepeats,
	formatVerifierOutcomes,
	type IndexOutcome,
} from "./report.ts";
import {
	earliest,
	formatUse,
	type QuestChange,
	questChangesQuery,
	readSamples,
	useByQuest,
} from "./resources.ts";

/** What the spend tool's answers carry beside their text. */
export interface CostDetails {
	readonly ok: boolean;
	readonly total?: LedgerTotal;
	readonly index?: IndexOutcome;
}

/** What the tool says when another session's pass holds the ledger. */
export const HELD_ELSEWHERE =
	"Another pass (a session's keeper, or the daily measure) holds the ledger, so this answer reads it as that pass leaves it, without indexing first.";

/** Rows of a query answer shown before the rest is left to the store. */
const QUERY_ROWS_SHOWN = 40;

/** Rows of a listing shown when the caller names no limit. */
const ROWS_SHOWN = 12;

/** The reports a call may ask for, of the tool's parameters. */
export interface ReportAsked {
	readonly resources?: boolean | undefined;
	readonly audit?: boolean | undefined;
	readonly query?: string | undefined;
	readonly repeats?: boolean | undefined;
	readonly regret?: boolean | undefined;
	readonly verify?: boolean | undefined;
	readonly payback?: boolean | undefined;
	readonly limit?: number | undefined;
}

/** What a report reads from. */
export interface ReportSources {
	/** The ledger, as the tool's pass left it. */
	readonly opened: TurnStore;
	/** The ledger's read-only connection, which a query goes through. */
	readonly reader: () => Promise<LedgerReader>;
	/** Where a listing too long to show is stored. */
	readonly results: () => ReturnType<typeof openSessionStore>;
	/** The tools the session defers, which the audit counts. */
	readonly deferred: () => readonly string[];
	/** Where each session's per-turn resource figures are kept. */
	readonly resourcesDir: string;
	/** The tool's pass, or undefined when another pass held the ledger. */
	readonly index: IndexOutcome | undefined;
}

/**
 * The report a call asked for, or undefined when it asked for none of
 * these and the total answers it.
 */
export async function askedReport(
	asked: ReportAsked,
	from: ReportSources,
): Promise<AgentToolResult<CostDetails> | undefined> {
	const reported = await reportFor(asked, from);
	if (reported === undefined || from.index !== undefined) return reported;
	return {
		...reported,
		content: [{ type: "text", text: HELD_ELSEWHERE }, ...reported.content],
	};
}

/** The one report asked for, as it reads. */
async function reportFor(
	asked: ReportAsked,
	from: ReportSources,
): Promise<AgentToolResult<CostDetails> | undefined> {
	const { opened, index } = from;
	const limit = asked.limit ?? ROWS_SHOWN;
	if (asked.resources) return resourcesReport(from, limit);

	if (asked.audit) {
		const read = await from.reader();
		const input = await gatherAudit(
			async (sql) => (await read.query(sql)).rows,
			{
				now: Date.now(),
				sessionsDir: sessionsDir(),
				deferred: [...from.deferred()],
			},
		);
		return {
			content: [{ type: "text", text: formatAudit(input, limit) }],
			details: { ok: true, index },
		};
	}

	if (asked.query !== undefined) return queryReport(asked.query, asked, from);

	if (asked.repeats) {
		const repeats = await opened.repeatedCalls(LEDGER_SCOPE);
		return listed(from, {
			view: formatRepeats(repeats, limit),
			records: repeats,
			unit: "repeats",
			narrowing: "Ask for a larger limit to see more.",
		});
	}

	if (asked.regret) {
		const regret = await opened.regret(LEDGER_SCOPE);
		return listed(from, {
			view: formatRegret(regret),
			records: regret.reAsked,
			unit: "regrets",
			narrowing: "Query the stored result for the full list.",
		});
	}

	if (asked.verify) {
		const outcomes = await opened.verifierOutcomes();
		return said(formatVerifierOutcomes(outcomes));
	}

	if (asked.payback) {
		const replay = await opened.paybackReplay();
		return said(formatPaybackReplay(replay));
	}
	return undefined;
}

/** The resources each quest's sessions used, heaviest first. */
async function resourcesReport(
	from: ReportSources,
	limit: number,
): Promise<AgentToolResult<CostDetails>> {
	const samples = readSamples(from.resourcesDir);
	const changes: QuestChange[] = [];
	if (samples.size > 0) {
		const answer = await (await from.reader()).query(
			questChangesQuery([...samples.keys()]),
		);
		for (const row of answer.rows) {
			changes.push({
				session: String(row.session_id),
				at: String(row.timestamp),
				quest: typeof row.quest === "string" ? row.quest : null,
			});
		}
	}
	const uses = useByQuest(samples, changes);
	return {
		...listed(from, {
			view: formatUse(uses, earliest(samples), limit),
			records: uses,
			unit: "quests",
			narrowing: "Ask for a larger limit to see more.",
		}),
		details: { ok: true, index: from.index },
	};
}

/** A query's rows, or what refused it. */
async function queryReport(
	sql: string,
	asked: ReportAsked,
	from: ReportSources,
): Promise<AgentToolResult<CostDetails>> {
	const { index } = from;
	let answer: QueryAnswer;
	try {
		answer = await (await from.reader()).query(sql);
	} catch (error) {
		// A refused or malformed query is the caller's to fix, so it is
		// answered with what SQLite or the guard said, not thrown.
		const reason = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Query refused: ${reason}` }],
			details: { ok: false, index },
		};
	}
	const limit = asked.limit ?? QUERY_ROWS_SHOWN;
	return {
		...listed(from, {
			view: formatQueryAnswer(answer, limit),
			records: answer.rows,
			unit: "rows",
			elided: answer.rows.length > limit,
			narrowing: "Query the stored rows, or aggregate in SQL and ask again.",
		}),
		details: { ok: true, index },
	};
}

/** A listing, its records stored when they run past what it shows. */
function listed(
	from: ReportSources,
	listing: Parameters<typeof citeListing>[1],
): AgentToolResult<CostDetails> {
	return {
		content: [{ type: "text", text: citeListing(from.results(), listing) }],
		details: { ok: true },
	};
}

/** A report that is its text alone. */
function said(text: string): AgentToolResult<CostDetails> {
	return { content: [{ type: "text", text }], details: { ok: true } };
}
