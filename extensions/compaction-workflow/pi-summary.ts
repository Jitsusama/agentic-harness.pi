/**
 * The `pi` provider: write the summary with pi's own summariser, the
 * one pi runs when no extension answers a compaction.
 *
 * It is last in the chain because it is the dearest: it serialises the
 * history into a fresh, uncached request. What running it through the
 * host buys over leaving the compaction to pi is everything the host
 * does around a summary: the focus other extensions contribute is
 * followed, their appendix is kept, and the attempt is recorded beside
 * the ones before it.
 *
 * It writes only on the spot, since it needs pi's preparation of the
 * compaction, and declines only when there is no model to write with.
 */

import { compact, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_PROVIDER_ID } from "../../lib/compaction/chain.ts";
import {
	type CompactionProvider,
	combinedFocus,
} from "../../lib/compaction/index.ts";

/** Asked after every other provider unless the chain says otherwise. */
const PI_PRECEDENCE = 1000;

/** pi prices models in dollars per million tokens. */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** The headers that carry a value; a null one means leave it unset. */
function presentHeaders(
	headers: Readonly<Record<string, string | null>> | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	return Object.fromEntries(
		Object.entries(headers).filter(
			(entry): entry is [string, string] => entry[1] !== null,
		),
	);
}

/** A compaction with pi's summariser. */
export function piSummaryProvider(pi: ExtensionAPI): CompactionProvider {
	return {
		id: PI_PROVIDER_ID,
		precedence: PI_PRECEDENCE,
		followsFocus: true,
		assess(request) {
			if (request.timing === "ahead") {
				return {
					ok: false,
					reason: "pi's summariser writes only when the compaction comes",
				};
			}
			const model = request.ctx.model;
			if (!model) return { ok: false, reason: "no model is selected" };
			// Uncached: the whole context is read at the input price.
			const dollars =
				(request.contextTokens * model.cost.input +
					request.expectedOutputTokens * model.cost.output) /
				TOKENS_PER_PRICE_UNIT;
			return { ok: true, dollars };
		},
		async write(request, signal) {
			const { ctx, preparation } = request;
			const model = ctx.model;
			if (!model) return { ok: false, reason: "no model is selected" };
			if (!preparation) {
				return { ok: false, reason: "pi's summariser needs its preparation" };
			}
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok || !auth.apiKey) {
					return { ok: false, reason: "no credentials for the model" };
				}
				// The host appends the file lists itself, as it does for
				// every provider, so pi is handed none to append.
				const result = await compact(
					{
						...preparation,
						fileOps: { read: new Set(), edited: new Set(), written: new Set() },
					},
					model,
					auth.apiKey,
					presentHeaders(auth.headers),
					combinedFocus(request.focus),
					signal,
					pi.getThinkingLevel(),
					undefined,
					undefined,
					undefined,
					undefined,
					ctx.sessionManager.getSessionId(),
				);
				return { ok: true, text: result.summary, usage: result.usage };
			} catch (error) {
				return {
					ok: false,
					reason: error instanceof Error ? error.message : String(error),
				};
			}
		},
	};
}
