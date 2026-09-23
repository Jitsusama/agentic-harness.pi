/**
 * Demote Workflow extension.
 *
 * Demotes old bash results out of the prompt in batches, only when a
 * batch pays for the cache rewrite it causes, and gives the model
 * `expand_demoted` to recover any of them by digest.
 *
 * One policy, two modes. By default it runs in shadow: every turn it
 * decides what it would demote and keeps the set it would have frozen,
 * and sends the prompt exactly as pi assembled it. With
 * `PI_DEMOTE_BASH_RESULTS=1` it acts on the same decisions. Shadow first
 * is the rule for every controller in the spend plan, and it is what
 * `/demote-status` reports from either way.
 *
 * Why batches: the provider's prompt cache is a prefix cache, so a
 * change mid-prompt re-writes everything after it. Demoting each result
 * as it left a recent window would have cost $10,242 a month more than
 * doing nothing, replayed over a month of real sessions. Batched through
 * compaction's own payback test and frozen in between, the same replay
 * nets about $300 a month. That is the size of this lever: real, small,
 * and a quality trade, which is why acting stays behind the flag.
 *
 * Nothing is deleted: the stored session keeps every result, pi's
 * `context` event only shapes what one request sends, and the full text
 * of every demotion stays recoverable through `expand_demoted` for as
 * long as the session's cache holds it. Every recovery is counted, as
 * the direct measure of how often a demotion was wrong.
 */

import type {
	ContextEvent,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	accumulateReexpansion,
	BoundedTextCache,
	INITIAL_REEXPANSION,
	planBatch,
	planDemotions,
	type ReexpansionTotals,
	reexpansionRate,
} from "../../lib/demote/index.ts";
import { cachePrices } from "../../lib/internal/cache-prices.ts";
import { boundedExpansion } from "./bounded.ts";
import { sizeOf } from "./size.ts";

type OneMessage = ContextEvent["messages"][number];

/**
 * Most recent tool results never demoted. The replay put a 10-result
 * window at about $550 a month against $300 for 30; 30 is kept because
 * nothing yet measures what a tighter window costs in quality.
 */
const KEEP_RECENT = 30;

/** Characters a stub leaves behind, near enough for the planner. */
const STUB_CHARS = 120;

/** Demoted results whose full text stays recoverable. */
const CACHE_CAPACITY = 2_000;

/** Published after every decision, acted on or not. */
export const DEMOTE_READING = "demote:reading";

/** Whether this session acts on its decisions or only records them. */
function acting(): boolean {
	return process.env.PI_DEMOTE_BASH_RESULTS === "1";
}

/** The joined text of a tool result's text blocks. */
function textOf(message: OneMessage): string {
	if (message.role !== "toolResult") return "";
	return message.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text",
		)
		.map((block) => block.text)
		.join("");
}

function turnsIn(messages: readonly OneMessage[]): number {
	let turns = 0;
	for (const message of messages) if (message.role === "assistant") turns++;
	return turns;
}

export default function demoteWorkflow(pi: ExtensionAPI) {
	const cache = new BoundedTextCache(CACHE_CAPACITY);
	let demoted = new Set<string>();
	let batches = 0;
	let removedChars = 0;
	let totals: ReexpansionTotals = INITIAL_REEXPANSION;

	pi.on("session_start", async () => {
		demoted = new Set();
		batches = 0;
		removedChars = 0;
		totals = INITIAL_REEXPANSION;
	});

	pi.on("context", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		const prices = cachePrices(
			model.cost,
			model.api,
			process.env.PI_CACHE_RETENTION,
		);
		if (!prices) return;

		const decision = planBatch({
			messages: event.messages.map(sizeOf),
			demoted,
			keepRecent: KEEP_RECENT,
			turnsElapsed: turnsIn(event.messages),
			stubChars: STUB_CHARS,
			readPrice: prices.readPrice,
			writePrice: prices.writePrice,
		});
		if (decision.fire) {
			for (const id of decision.candidates) demoted.add(id);
			batches += 1;
			removedChars += decision.droppedChars;
			totals = accumulateReexpansion(totals, {
				demoted: decision.candidates.length,
			});
		}
		pi.events.emit(DEMOTE_READING, {
			acting: acting(),
			fired: decision.fire,
			margin: decision.margin,
			batches,
			demoted: demoted.size,
			removedChars,
		});

		if (!acting() || demoted.size === 0) return;

		// The frozen set is re-applied as the same stubs every call, so the
		// prompt only changes when a batch fires.
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role !== "toolResult") return message;
			if (!demoted.has(message.toolCallId)) return message;
			const text = textOf(message);
			const [plan] = planDemotions([
				{ index: 0, toolName: message.toolName, text },
			]);
			cache.set(plan.digest, text);
			changed = true;
			return {
				...message,
				content: [{ type: "text" as const, text: plan.stubText }],
			};
		});
		if (changed) return { messages };
	});

	pi.registerCommand("demote-status", {
		description:
			"Show what batch demotion has done this session, or would have done in shadow mode.",
		handler: async (_args, ctx) => {
			const mode = acting() ? "acting" : "shadow";
			const rate = (reexpansionRate(totals) * 100).toFixed(1);
			ctx.ui.notify(
				`demote (${mode}): ${batches} batches, ${demoted.size} results, ` +
					`${removedChars.toLocaleString()} chars off every later prompt, ` +
					`${totals.reexpanded} recovered (${rate}%)`,
				"info",
			);
		},
	});

	pi.registerTool({
		name: "expand_demoted",
		label: "Expand Demoted",
		description:
			"Recover the full text of a demoted bash result, by the digest named in its stub.",
		parameters: Type.Object({
			digest: Type.String({
				description: "The digest named in the demotion stub.",
			}),
		}),
		async execute(_toolCallId, params) {
			const text = cache.get(params.digest);
			if (text === undefined) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No demoted result found for digest ${params.digest}. It may have aged out of the cache, or never existed.`,
						},
					],
					isError: true,
					details: { digest: params.digest, found: false },
				};
			}
			totals = accumulateReexpansion(totals, { reexpanded: 1 });
			const details = { digest: params.digest, found: true as const };
			return {
				content: [
					{ type: "text" as const, text: boundedExpansion(text, details) },
				],
				details,
			};
		},
	});
}
