/**
 * Cost Workflow extension.
 *
 * The one place in this package that reasons about money. Cost is
 * derived from the session logs pi already writes rather than recorded a
 * second time, so there is a single writer of the truth and the ledger
 * can be rebuilt from scratch whenever its shape changes.
 *
 * The `cost` tool indexes those logs into a content-addressed store and
 * answers what was spent, grouped by repo, quest, model, day or session.
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
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { CostSlice } from "@jitsusama/agentic-harness.core/observability";
import {
	type CostDimension,
	type LedgerTotal,
	openTurnStore,
	registerRunRecorder,
	type TurnStore,
} from "@jitsusama/agentic-harness.core/observability";
import {
	citeListing,
	openSessionStore,
} from "@jitsusama/agentic-harness.core/result";
import { Type } from "@sinclair/typebox";
import { packageStateDir } from "../../lib/internal/package-state-dir.js";
import { indexSessionLogs } from "./indexer.js";
import { formatCostMeter } from "./meter.js";
import {
	formatIndexOutcome,
	formatSlices,
	formatTotal,
	type IndexOutcome,
} from "./report.js";

/** Dimensions the tool will group by, in the ledger's own vocabulary. */
const DIMENSIONS: readonly CostDimension[] = [
	"repo",
	"quest",
	"model",
	"day",
	"session",
	"kind",
];

/** Human wording for each dimension's heading. */
const HEADINGS: Record<CostDimension, string> = {
	repo: "Cost by repo",
	quest: "Cost by quest",
	model: "Cost by model",
	day: "Cost by day",
	session: "Cost by session",
	kind: "Cost by kind",
};

interface CostDetails {
	readonly ok: boolean;
	readonly total?: LedgerTotal;
	readonly index?: IndexOutcome;
}

/** The one cost reading on the status line. */
const STATUS_KEY = "cost:meter";

/** Cost of an assistant turn, or zero for anything else. */
function assistantCost(message: { role: string }): number {
	if (message.role === "assistant" && "usage" in message) {
		return (message as AssistantMessage).usage.cost.total;
	}
	return 0;
}

export default function costWorkflow(pi: ExtensionAPI) {
	let store: TurnStore | null = null;
	let watermarks = "";
	let ctxRef: ExtensionContext | null = null;
	let unregisterRuns: (() => void) | null = null;
	// What this process has spent. Fan-out is added here rather than
	// shown separately, because it is the same money: a council round
	// costs what it costs whether or not the parent did the talking.
	let sessionSpend = 0;
	// What the day had cost before this process started. Held apart from
	// the live figure so a restored session cannot count its own earlier
	// turns twice, once from the ledger and once from the branch.
	let dayBefore = 0;

	const refreshStatus = (): void => {
		if (!ctxRef) return;
		const text = formatCostMeter({
			session: sessionSpend,
			day: dayBefore + sessionSpend,
		});
		ctxRef.ui.setStatus(
			STATUS_KEY,
			text ? ctxRef.ui.theme.fg("muted", text) : undefined,
		);
	};

	const open = async (): Promise<TurnStore> => {
		if (store) return store;
		const dir = packageStateDir("observability");
		mkdirSync(dir, { recursive: true });
		watermarks = join(dir, "ledger-watermarks.json");
		store = await openTurnStore(join(dir, "ledger.db"));
		return store;
	};

	pi.on("message_end", async (event) => {
		sessionSpend += assistantCost(event.message);
		refreshStatus();
	});

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		sessionSpend = 0;
		if (!unregisterRuns) {
			unregisterRuns = registerRunRecorder((record) => {
				sessionSpend += record.cost.total;
				refreshStatus();
			});
		}
		try {
			const opened = await open();
			const today = new Date().toISOString().slice(0, 10);
			const days = await opened.costBy("day");
			dayBefore = days.find((slice) => slice.key === today)?.cost ?? 0;
		} catch {
			// A ledger that will not open leaves the day unknown, which the
			// meter shows by reporting the session alone rather than a
			// figure it cannot stand behind.
			dayBefore = 0;
		}
		refreshStatus();
	});

	pi.on("session_shutdown", async () => {
		unregisterRuns?.();
		unregisterRuns = null;
		ctxRef?.ui.setStatus(STATUS_KEY, undefined);
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
			"already writes. Group by repo, quest, model, day, session or " +
			"kind, or omit a dimension for the overall total. Indexing is " +
			"incremental and runs automatically before a report; pass " +
			"reindex to force a pass without reporting. Every answer states " +
			"its coverage, including turns that carried no usage and spend " +
			"whose session named no repo or quest.",
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
					description: "How many slices to show. Defaults to 12.",
				}),
			),
			reindex: Type.Optional(
				Type.Boolean({
					description:
						"Run an index pass and report what it read, without a spend report.",
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

			const total = await opened.total();
			const sections = [formatTotal(total)];
			let slices: readonly CostSlice[] = [];
			if (params.by) {
				slices = await opened.costBy(params.by);
				sections.push(
					formatSlices(HEADINGS[params.by], slices, params.limit ?? 12),
				);
			}
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
