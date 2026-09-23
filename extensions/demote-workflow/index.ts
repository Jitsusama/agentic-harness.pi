/**
 * Demote Workflow extension.
 *
 * Rewrites an already-resident bash result that `context-shadow-workflow`
 * found reclaimable into a short stub, and gives the model a tool to ask
 * for it back by digest.
 *
 * This is the actuator half of demote-rather-than-delete; the other
 * extension is only the shadow-mode measurement. Rewriting what is
 * sent is a quality trade, not provable waste: the demoted result
 * might have been the part that mattered on this exact call, and there
 * is no sensor yet that would catch that going wrong. So this stays
 * behind `PI_DEMOTE_BASH_RESULTS`, off by default, same treatment as
 * `output-ceiling-workflow` and for the same reason.
 *
 * Reversibility is the entire point: the full text of every demotion
 * is kept, for as long as the bounded cache holds it, so asking for it
 * back is answerable through `expand_demoted`. Every re-expansion is
 * counted, which is the direct measure of pruner error the wider plan
 * calls for: a controller that gets asked back for what it just cut is
 * wrong about that cut, whatever it saved.
 */

import type {
	ContextEvent,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	findReclaimable,
	type ToolResultLike,
} from "../../lib/context/index.js";
import {
	accumulateReexpansion,
	BoundedTextCache,
	INITIAL_REEXPANSION,
	planDemotions,
	type ReexpansionTotals,
} from "../../lib/demote/index.js";
import { boundedExpansion } from "./bounded.js";

type OneMessage = ContextEvent["messages"][number];

const KEEP_RECENT = 30;
const CACHE_CAPACITY = 500;

function toolResultLike(message: OneMessage): ToolResultLike {
	if (message.role !== "toolResult") return { role: message.role };
	return {
		role: message.role,
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		content: message.content,
	};
}

/** Whether the actuator is turned on. Unset or anything but "1" leaves this inert. */
function enabled(): boolean {
	return process.env.PI_DEMOTE_BASH_RESULTS === "1";
}

/** The joined text of a toolResult message's text blocks. */
function textOf(message: OneMessage): string {
	if (message.role !== "toolResult") return "";
	return message.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text",
		)
		.map((block) => block.text)
		.join("");
}

export default function demoteWorkflow(pi: ExtensionAPI) {
	const cache = new BoundedTextCache(CACHE_CAPACITY);
	let totals: ReexpansionTotals = INITIAL_REEXPANSION;

	pi.on("session_start", async () => {
		totals = INITIAL_REEXPANSION;
	});

	pi.on("context", async (event) => {
		if (!enabled()) return;

		const likeMessages = event.messages.map(toolResultLike);
		const analysis = findReclaimable(likeMessages, { keepRecent: KEEP_RECENT });
		if (analysis.candidates.length === 0) return;

		const plans = planDemotions(
			analysis.candidates.map((candidate) => ({
				index: candidate.index,
				toolName: candidate.toolName,
				text: textOf(event.messages[candidate.index]),
			})),
		);

		// A candidate found on one call is still a candidate on the next,
		// since the kept window only moves forward. Counting every
		// re-application would inflate "demoted" far past the number of
		// distinct results actually cut, and wreck the re-expansion rate
		// this exists to measure. Only a digest the cache has not already
		// seen this session counts as a new demotion.
		let newlyDemoted = 0;
		const byIndex = new Map(plans.map((plan) => [plan.index, plan]));
		const messages = event.messages.map((message, index) => {
			const plan = byIndex.get(index);
			if (!plan || message.role !== "toolResult") return message;
			if (cache.get(plan.digest) === undefined) newlyDemoted++;
			cache.set(plan.digest, textOf(message));
			return {
				...message,
				content: [{ type: "text" as const, text: plan.stubText }],
			};
		});

		if (newlyDemoted > 0) {
			totals = accumulateReexpansion(totals, { demoted: newlyDemoted });
		}
		return { messages };
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
