/**
 * Write the compaction summary from the conversation the session
 * already cached, instead of from pi's text dump of it.
 *
 * pi's summariser serialises the history under its own system prompt
 * with caching off, so every compaction pays full input price for
 * roughly 150k tokens, truncates every tool result to 2,000
 * characters, and splits a long turn into two calls run one after the
 * other. Here the request the session last sent is kept byte for byte,
 * the messages since are appended, and one closing message asks for
 * the checkpoint. The prefix is a cache read, the model sees every
 * token it summarises, and there is one call.
 *
 * Anything this cannot do cleanly it declines, and pi's own summariser
 * runs as before, so the worst case is today's behaviour. Each decline
 * is recorded with its reason, so how often it happens is measurable.
 */

import type {
	Api,
	AssistantMessage,
	Model,
	Usage,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	type CompactionResult,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
	extendSentPayload,
	newContributions,
	readSummary,
	SUMMARY_CONTRIBUTIONS,
	SUMMARY_SPAN,
	type SummaryContributions,
	summaryInstruction,
	withFileLists,
} from "../../lib/compaction/index.ts";
import { processGlobal } from "../../lib/internal/process-global.ts";

/** Custom entry recording a compaction this summariser handed back to pi. */
export const SUMMARY_FALLBACK_ENTRY = "compaction-summary-fallback";

/** Marks a compaction entry's details as written by this summariser. */
export const SUMMARISER = "conversation";

/** pi's own cap on a summary: this share of the reserve, within the model's limit. */
const SUMMARY_SHARE_OF_RESERVE = 0.8;

/** How long Anthropic keeps a cache entry under each retention pi asks for. */
const CACHE_LIFETIME_MS = { long: 60 * 60_000, short: 5 * 60_000 } as const;

/** Slack under the lifetime, for the time the request takes to arrive. */
const CACHE_EXPIRY_MARGIN_MS = 30_000;

interface SentRequest {
	readonly payload: unknown;
	readonly leafId: string | null;
	readonly modelId: string | undefined;
	readonly at: number;
}

/**
 * Whether the cache the last request wrote may have expired. Reading
 * the conversation back cold would write all of it at the cache-write
 * price, several times what pi's uncached summariser pays, so a manual
 * compaction after a long pause is left to pi.
 */
function cacheMayHaveExpired(sentAt: number, now: number): boolean {
	const lifetime =
		process.env.PI_CACHE_RETENTION === "long"
			? CACHE_LIFETIME_MS.long
			: CACHE_LIFETIME_MS.short;
	return now - sentAt > lifetime - CACHE_EXPIRY_MARGIN_MS;
}

/**
 * The last request, carried across a `/reload`. A reload loads this
 * module afresh, so without it the first compaction after one finds
 * nothing sent and hands back to pi, even though the cache still holds
 * that request. It is taken by the session it came from and no other.
 */
const reloadHandoff = processGlobal<{
	held?: { readonly sessionId: string; readonly sent: SentRequest };
}>("agentic-harness.pi:compaction-summary-handoff", () => ({}));

function enabled(): boolean {
	return process.env.PI_COMPACTION_SUMMARY !== "pi";
}

/**
 * Remember the last request the session sent and answer compaction
 * with a summary asked of that same conversation.
 */
export function registerConversationSummary(pi: ExtensionAPI): void {
	let sent: SentRequest | null = null;

	pi.on("session_start", async (event, ctx) => {
		const held = reloadHandoff.held;
		reloadHandoff.held = undefined;
		sent =
			event.reason === "reload" &&
			held?.sessionId === ctx.sessionManager.getSessionId()
				? held.sent
				: null;
	});
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "reload" || !sent) return;
		reloadHandoff.held = { sessionId: ctx.sessionManager.getSessionId(), sent };
	});
	pi.on("session_compact", async () => {
		sent = null;
	});

	// Only the session's own requests pass through here; pi's summariser
	// and other direct calls do not, so this is always the conversation.
	pi.on("before_provider_request", async (event, ctx) => {
		sent = {
			payload: event.payload,
			leafId: ctx.sessionManager.getLeafId(),
			modelId: ctx.model?.id,
			at: Date.now(),
		};
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!enabled()) return;
		// Asked for before anything can decline, so a contributor always
		// holds this compaction's request and never a stale one; listeners
		// fill it in synchronously, as pi.events calls them.
		const contributions = newContributions(event.preparation);
		pi.events.emit(SUMMARY_CONTRIBUTIONS, contributions);
		const outcome = await summarise(event, ctx, sent, contributions);
		if (outcome.ok) {
			contributions.handled = true;
			return { compaction: outcome.compaction };
		}
		if (event.signal.aborted) return;
		pi.appendEntry(SUMMARY_FALLBACK_ENTRY, { reason: outcome.reason });
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Compacting with pi's summariser: ${outcome.reason}.`,
				"info",
			);
		}
	});
}

/**
 * A compaction result carrying the call's usage, which pi records on
 * the compaction entry where the cost ledger reads it. Older pi
 * typings lack the field; the runtime has carried it since 0.85.
 */
interface MeteredCompaction extends CompactionResult {
	readonly usage: Usage;
}

type Summarised =
	| { ok: true; compaction: MeteredCompaction }
	| { ok: false; reason: string };

async function summarise(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	sent: SentRequest | null,
	contributions: SummaryContributions,
): Promise<Summarised> {
	const model = ctx.model;
	if (!model) return { ok: false, reason: "no model is selected" };
	if (model.api !== "anthropic-messages") {
		return { ok: false, reason: `the ${model.api} API is not supported` };
	}
	if (!sent) return { ok: false, reason: "nothing has been sent this session" };
	// The kept request is the one that overflowed, so sending it again
	// with more on the end can only fail the same way.
	if (event.reason === "overflow") {
		return {
			ok: false,
			reason: "the last request overflowed the context window",
		};
	}
	if (sent.modelId !== model.id) {
		return { ok: false, reason: "the model changed since the last request" };
	}
	if (cacheMayHaveExpired(sent.at, Date.now())) {
		return { ok: false, reason: "the cached conversation may have expired" };
	}

	const tail = unsentMessages(ctx, sent.leafId);
	if (!tail.ok) return tail;

	const { preparation } = event;
	const instruction = summaryInstruction({
		hasPreviousSummary: preparation.previousSummary !== undefined,
		customInstructions: focus(
			event.customInstructions,
			contributions.instructions,
		),
	});
	const maxTokens = summaryCap(model, preparation.settings.reserveTokens);
	const messages = convertToLlm([
		...tail.messages,
		{
			role: "user",
			content: [{ type: "text", text: instruction }],
			timestamp: Date.now(),
		},
	]);

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		return { ok: false, reason: "no credentials for the model" };
	}

	let splice: string | undefined;
	let reply: AssistantMessage;
	try {
		reply = await completeSimple(
			model,
			{ messages },
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: event.signal,
				sessionId: ctx.sessionManager.getSessionId(),
				maxTokens,
				onPayload: (built: unknown) => {
					const joined = extendSentPayload(sent.payload, built, maxTokens);
					if (joined.ok) return joined.payload;
					splice = joined.reason;
					throw new Error(joined.reason);
				},
			},
		);
	} catch (error) {
		return { ok: false, reason: splice ?? describe(error) };
	}
	const read = readSummary(reply);
	if (!read.ok) return { ok: false, reason: splice ?? read.reason };

	const { summary, readFiles, modifiedFiles } = withFileLists(
		read.text,
		preparation.fileOps,
	);
	const compaction: MeteredCompaction = {
		summary: `${SUMMARY_SPAN}\n\n${summary}${contributions.appendix.join("")}`,
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		usage: reply.usage,
		details: { readFiles, modifiedFiles, summariser: SUMMARISER },
	};
	return { ok: true, compaction };
}

type Tail =
	| { ok: true; messages: ReturnType<typeof sessionEntryToContextMessages> }
	| { ok: false; reason: string };

/**
 * The messages the session holds that the last request did not carry:
 * the reply to it and any tool results since. The first has to be that
 * reply, or the request is not the one this conversation continues.
 */
function unsentMessages(ctx: ExtensionContext, leafId: string | null): Tail {
	const branch = ctx.sessionManager.getBranch();
	const at = leafId === null ? -1 : branch.findIndex((e) => e.id === leafId);
	if (at < 0)
		return { ok: false, reason: "the last request is not on this branch" };
	const messages = branch.slice(at + 1).flatMap(sessionEntryToContextMessages);
	if (messages[0]?.role !== "assistant") {
		return { ok: false, reason: "the session moved on from the last request" };
	}
	return { ok: true, messages };
}

function summaryCap(model: Model<Api>, reserveTokens: number): number {
	return Math.min(
		Math.floor(SUMMARY_SHARE_OF_RESERVE * reserveTokens),
		model.maxTokens,
	);
}

function focus(
	custom: string | undefined,
	contributed: readonly string[],
): string | undefined {
	// A contributor that also asked for this compaction by hand can hand
	// in the same focus both ways; it is said once.
	const parts = new Set(
		[custom, ...contributed].filter((p): p is string => !!p?.trim()),
	);
	return parts.size > 0 ? [...parts].join("\n\n") : undefined;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
