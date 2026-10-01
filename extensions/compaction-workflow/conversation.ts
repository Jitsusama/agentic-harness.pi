/**
 * The `conversation` provider: write the compaction summary from the
 * conversation the session already cached, instead of from pi's text
 * dump of it.
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
 * Anything this cannot do cleanly it declines, with the reason, and
 * the host asks the next provider in its chain. That includes a
 * conversation so close to the window that the summary would have no
 * room: the model accepts a request whose output allowance runs past
 * the window and stops when it gets there, so the summary would come
 * back cut off. A failure that a second call could get past (a dropped
 * stream, an overloaded provider) is marked retryable, and the host
 * asks once more.
 *
 * The last request survives a `/reload` in the process and a restart
 * of pi on disk (see `kept-request.ts`), so the first compaction after
 * either can still read the conversation back from cache.
 */

import type {
	Api,
	AssistantMessage,
	Model,
	Usage,
} from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	type ExtensionAPI,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
	type CompactionProvider,
	type CompactionRequest,
	type CompactionWritten,
	combinedFocus,
	extendSentPayload,
	readSummary,
	SUMMARY_SPAN,
	summaryInstruction,
} from "../../lib/compaction/index.ts";
import { cachePrices } from "../../lib/internal/cache-prices.ts";
import { processGlobal } from "../../lib/internal/process-global.ts";
import {
	keepingRequests,
	keptRequestDir,
	type SentRequest,
	saveKeptRequest,
	sweepKeptRequests,
	takeKeptRequest,
} from "./kept-request.ts";

/** Marks a compaction entry's details as written by this provider. */
export const CONVERSATION_PROVIDER_ID = "conversation";

/** Asked first of the built-in providers, since it is the cheapest. */
const CONVERSATION_PRECEDENCE = 100;

/** How long Anthropic keeps a cache entry under each retention pi asks for. */
const CACHE_LIFETIME_MS = { long: 60 * 60_000, short: 5 * 60_000 } as const;

/** Slack under the lifetime, for the time the request takes to arrive. */
const CACHE_EXPIRY_MARGIN_MS = 30_000;

/** pi prices models in dollars per million tokens. */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * Kept clear of the window beside the conversation, for the closing
 * instruction and the messages since the last request was counted.
 */
const WINDOW_MARGIN_TOKENS = 4_000;

/** No summary worth having is written in less room than this. */
const MIN_SUMMARY_ROOM_TOKENS = 16_000;

/**
 * Errors pi-ai calls transient, for a pi from before it exported its
 * own classifier: a dropped or reset stream, an overloaded or
 * rate-limited provider, a server error.
 */
const TRANSIENT_ERROR =
	/overloaded|rate.?limit|too many requests|\b429\b|\b5\d\d\b|stream ended|message_stop|econnreset|socket hang up|timed? ?out|network|fetch failed/i;

type Planned =
	| {
			ok: true;
			model: Model<Api>;
			sent: SentRequest;
			tail: ReturnType<typeof sessionEntryToContextMessages>;
			/** Output the window leaves room for, when the model says its size. */
			room?: number;
	  }
	| { ok: false; reason: string };

/** Where the provider keeps a request across a restart, and whether. */
export interface ConversationOptions {
	/** The directory for kept requests; tests point it somewhere scratch. */
	readonly keptDir?: string;
	/** Whether to keep requests on disk; `PI_COMPACTION_KEEP_REQUEST`. */
	readonly keep?: boolean;
}

/**
 * The last request, carried across a `/reload`. A reload loads this
 * module afresh, so without it the first compaction after one finds
 * nothing sent and declines, even though the cache still holds that
 * request. It is taken by the session it came from and no other.
 */
const reloadHandoff = processGlobal<{
	held?: { readonly sessionId: string; readonly sent: SentRequest };
}>("agentic-harness.pi:compaction-summary-handoff", () => ({}));

/**
 * Remember the last request the session sent, and write summaries of
 * that same conversation when the host asks.
 */
export function conversationProvider(
	pi: ExtensionAPI,
	options: ConversationOptions = {},
): CompactionProvider {
	let sent: SentRequest | null = null;
	const keptDir = options.keptDir ?? keptRequestDir();
	const keep = options.keep ?? keepingRequests();

	pi.on("session_start", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const held = reloadHandoff.held;
		reloadHandoff.held = undefined;
		if (event.reason === "reload") {
			sent = held?.sessionId === sessionId ? held.sent : null;
			return;
		}
		sent = null;
		if (!keep) return;
		sent = takeKeptRequest(keptDir, sessionId);
		sweepKeptRequests(keptDir);
	});
	pi.on("session_shutdown", async (event, ctx) => {
		if (!sent) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (event.reason === "reload") {
			reloadHandoff.held = { sessionId, sent };
		} else if (keep) {
			saveKeptRequest(keptDir, sessionId, sent);
		}
	});
	pi.on("session_compact", async () => {
		sent = null;
	});
	// Only the session's own requests pass through here; summaries and
	// other direct calls do not, so this is always the conversation.
	pi.on("before_provider_request", async (event, ctx) => {
		sent = {
			payload: event.payload,
			leafId: ctx.sessionManager.getLeafId(),
			modelId: ctx.model?.id,
			at: Date.now(),
		};
	});

	return {
		id: CONVERSATION_PROVIDER_ID,
		precedence: CONVERSATION_PRECEDENCE,
		followsFocus: true,
		assess(request) {
			const planned = plan(request, sent);
			if (!planned.ok) return planned;
			return { ok: true, dollars: priced(request, planned.model) };
		},
		async write(request, signal) {
			const planned = plan(request, sent);
			if (!planned.ok) return planned;
			try {
				return await writeFrom(request, planned, signal);
			} catch (error) {
				return { ok: false, reason: describe(error) };
			}
		},
	};
}

/**
 * Whether the cache the last request wrote may have expired. Reading
 * the conversation back cold would write all of it at the cache-write
 * price, several times what pi's uncached summariser pays, so a
 * compaction after a long pause is left to the next provider.
 */
function cacheMayHaveExpired(sentAt: number, now: number): boolean {
	const lifetime =
		process.env.PI_CACHE_RETENTION === "long"
			? CACHE_LIFETIME_MS.long
			: CACHE_LIFETIME_MS.short;
	return now - sentAt > lifetime - CACHE_EXPIRY_MARGIN_MS;
}

/** Everything that decides, before any call, whether the cache can be used. */
function plan(request: CompactionRequest, sent: SentRequest | null): Planned {
	// The kept request is the one that overflowed, so sending it again
	// with more on the end can only fail the same way.
	if (request.reason === "overflow") {
		return {
			ok: false,
			reason: "the last request overflowed the context window",
		};
	}
	const model = request.ctx.model;
	if (!model) return { ok: false, reason: "no model is selected" };
	if (model.api !== "anthropic-messages") {
		return { ok: false, reason: `the ${model.api} API is not supported` };
	}
	if (!sent) return { ok: false, reason: "nothing has been sent this session" };
	if (sent.modelId !== model.id) {
		return { ok: false, reason: "the model changed since the last request" };
	}
	if (cacheMayHaveExpired(sent.at, Date.now())) {
		return { ok: false, reason: "the cached conversation may have expired" };
	}
	const tail = unsentMessages(request.branch, sent.leafId);
	if (!tail.ok) return tail;
	const room = windowRoom(request, model);
	if (room !== undefined && room < neededRoom(request)) {
		return {
			ok: false,
			reason: "too little of the window is left to write the summary",
		};
	}
	return {
		ok: true,
		model,
		sent,
		tail: tail.messages,
		...(room !== undefined ? { room } : {}),
	};
}

/**
 * The output the window leaves room for beside the conversation, or
 * nothing when the model does not say how large its window is.
 */
function windowRoom(
	request: CompactionRequest,
	model: Model<Api>,
): number | undefined {
	const window = model.contextWindow;
	if (!(typeof window === "number" && window > 0)) return undefined;
	return window - request.contextTokens - WINDOW_MARGIN_TOKENS;
}

/**
 * The least room worth writing a summary in: twice what one usually
 * takes, thinking included, but never less than a floor nor more than
 * the summary is allowed anyway.
 */
function neededRoom(request: CompactionRequest): number {
	return Math.min(
		request.maxSummaryTokens,
		Math.max(MIN_SUMMARY_ROOM_TOKENS, 2 * request.expectedOutputTokens),
	);
}

/** Whether a failed reply is one a second call could get past. */
function retryable(reply: AssistantMessage): boolean {
	const classify = (piAi as Record<string, unknown>).isRetryableAssistantError;
	if (typeof classify === "function") return Boolean(classify(reply));
	return (
		reply.stopReason === "error" &&
		TRANSIENT_ERROR.test(reply.errorMessage ?? "")
	);
}

/** Reading the context back from cache, and writing the summary. */
function priced(request: CompactionRequest, model: Model<Api>): number {
	const cache = cachePrices(
		model.cost,
		model.api,
		process.env.PI_CACHE_RETENTION,
	);
	const read = cache?.readPrice ?? model.cost.input;
	return (
		(request.contextTokens * read +
			request.expectedOutputTokens * model.cost.output) /
		TOKENS_PER_PRICE_UNIT
	);
}

async function writeFrom(
	request: CompactionRequest,
	planned: Extract<Planned, { ok: true }>,
	signal: AbortSignal,
): Promise<CompactionWritten> {
	const { ctx } = request;
	const { model, sent } = planned;
	const maxTokens = Math.min(
		request.maxSummaryTokens,
		model.maxTokens,
		planned.room ?? Number.POSITIVE_INFINITY,
	);
	const replacedTokens = request.replacedTokens;
	const instruction = summaryInstruction({
		hasPreviousSummary: request.hasPreviousSummary,
		customInstructions: combinedFocus(request.focus),
		...(replacedTokens !== undefined
			? { length: { replacedTokens, maxOutputTokens: maxTokens } }
			: {}),
	});
	const messages = convertToLlm([
		...planned.tail,
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
				signal,
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
	if (!read.ok) {
		if (splice) return { ok: false, reason: splice };
		return {
			ok: false,
			reason: read.reason,
			...(retryable(reply) ? { retryable: true } : {}),
		};
	}
	const usage: Usage = reply.usage;
	return { ok: true, text: `${SUMMARY_SPAN}\n\n${read.text}`, usage };
}

type Tail =
	| { ok: true; messages: ReturnType<typeof sessionEntryToContextMessages> }
	| { ok: false; reason: string };

/**
 * The messages the session holds that the last request did not carry:
 * the reply to it and any tool results since. The first has to be that
 * reply, or the request is not the one this conversation continues.
 */
function unsentMessages(
	branch: readonly SessionEntry[],
	leafId: string | null,
): Tail {
	const at = leafId === null ? -1 : branch.findIndex((e) => e.id === leafId);
	if (at < 0)
		return { ok: false, reason: "the last request is not on this branch" };
	const messages = branch.slice(at + 1).flatMap(sessionEntryToContextMessages);
	if (messages[0]?.role !== "assistant") {
		return { ok: false, reason: "the session moved on from the last request" };
	}
	return { ok: true, messages };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
