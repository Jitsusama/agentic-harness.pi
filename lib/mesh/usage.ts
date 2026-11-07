/**
 * Usage: what a session's model calls have taken, said in its presence
 * for the launcher's drawer.
 *
 * The launcher drew no figures for a session, and guessing them from its
 * log would be one more file it reads for every session it lists. So a
 * session says its own, under OpenTelemetry's gen_ai names where there
 * is one: the model asked for and the one that answered, its provider,
 * the tokens of its last call and of today, how full its context is, how
 * many calls it made today and how long the last one took, and what they
 * cost at the prices pi put on them. Spend-watch stays the authority on
 * the bill; these are the session's own reading.
 *
 * Today is the local day. It carries across a reload, a restart and a
 * rollover in the presence the peer takes over, and a session that has
 * none for today counts its own log since midnight.
 */

/** Tokens, in gen_ai's names. */
export interface Tokens {
	readonly "gen_ai.usage.input_tokens": number;
	readonly "gen_ai.usage.output_tokens": number;
	readonly "gen_ai.usage.cache_read.input_tokens": number;
	readonly "gen_ai.usage.cache_creation.input_tokens": number;
}

/** The last model call: when it ended, how long it took, and its first token. */
export interface LastTurn {
	readonly at: string;
	readonly duration_ms: number;
	/** Missing when the call streamed nothing before it ended. */
	readonly first_token_ms?: number;
}

/** A session's usage, as its presence says it. */
export interface SessionUsage {
	/** The local day `today` counts, as YYYY-MM-DD. */
	readonly day: string;
	readonly "gen_ai.request.model"?: string;
	readonly "gen_ai.response.model"?: string;
	readonly "gen_ai.provider.name"?: string;
	readonly last?: Tokens;
	readonly today: Tokens;
	/** Context tokens in use and the window's size, when pi can say. */
	readonly context?: { readonly used: number | null; readonly limit: number };
	readonly turns: { readonly today: number; readonly last?: LastTurn };
	readonly "pi.cost.usd": { readonly last?: number; readonly today: number };
}

/** What a model call's message says of itself, as pi records it. */
export interface CallMessage {
	readonly role: string;
	readonly provider?: string;
	readonly model?: string;
	readonly responseModel?: string;
	readonly usage?: {
		readonly input?: number;
		readonly output?: number;
		readonly cacheRead?: number;
		readonly cacheWrite?: number;
		readonly cost?: { readonly total?: number };
	};
}

const NONE: Tokens = {
	"gen_ai.usage.input_tokens": 0,
	"gen_ai.usage.output_tokens": 0,
	"gen_ai.usage.cache_read.input_tokens": 0,
	"gen_ai.usage.cache_creation.input_tokens": 0,
};

/** The local day a time falls on, as YYYY-MM-DD. */
export function localDay(at: Date): string {
	const month = String(at.getMonth() + 1).padStart(2, "0");
	const day = String(at.getDate()).padStart(2, "0");
	return `${at.getFullYear()}-${month}-${day}`;
}

/** Usage with nothing counted, for a day. */
export function noUsage(day: string): SessionUsage {
	return { day, today: NONE, turns: { today: 0 }, "pi.cost.usd": { today: 0 } };
}

/** Usage carried in from an earlier presence, when it counts today. */
export function carriedUsage(
	value: unknown,
	now: Date,
): SessionUsage | undefined {
	if (!isUsage(value) || value.day !== localDay(now)) return undefined;
	return value;
}

/** How a call went, beside what its message says. */
export interface CallTiming {
	/** When it ended. */
	readonly at: Date;
	/** When it was asked, if seen. */
	readonly startedAt?: number;
	/** When its first token came, if any did. */
	readonly firstTokenAt?: number;
	/** The context pi reports after it. */
	readonly context?: { readonly used: number | null; readonly limit: number };
}

/**
 * Usage with one more model call counted, starting today afresh when the
 * day has turned. A message that is not a model call's leaves it as it
 * was.
 */
export function withCall(
	usage: SessionUsage,
	message: CallMessage,
	timing: CallTiming,
): SessionUsage {
	if (message.role !== "assistant" || !message.usage) return usage;
	const day = localDay(timing.at);
	const base = usage.day === day ? usage : noUsage(day);
	const last = tokensOf(message.usage);
	const cost = message.usage.cost?.total ?? 0;
	const end = timing.at.getTime();
	const started = timing.startedAt;
	return {
		day,
		...(message.model ? { "gen_ai.request.model": message.model } : {}),
		"gen_ai.response.model": message.responseModel ?? message.model ?? "",
		...(message.provider ? { "gen_ai.provider.name": message.provider } : {}),
		last,
		today: added(base.today, last),
		...(timing.context ? { context: timing.context } : {}),
		turns: {
			today: base.turns.today + 1,
			...(started === undefined
				? {}
				: {
						last: {
							at: timing.at.toISOString(),
							duration_ms: Math.max(0, end - started),
							...(timing.firstTokenAt === undefined
								? {}
								: {
										first_token_ms: Math.max(0, timing.firstTokenAt - started),
									}),
						},
					}),
		},
		"pi.cost.usd": { last: cost, today: base["pi.cost.usd"].today + cost },
	};
}

/**
 * Today's usage from a session's own log: every model call recorded
 * since local midnight, for a session that carried none in.
 */
export function usageFromLog(
	entries: readonly unknown[],
	now: Date,
): SessionUsage {
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	let usage = noUsage(localDay(now));
	for (const entry of entries) {
		const call = callOf(entry, midnight.getTime());
		if (call) usage = withCall(usage, call.message, { at: call.at });
	}
	return usage;
}

/** A logged model call made at or after `since`, or nothing. */
function callOf(
	entry: unknown,
	since: number,
): { message: CallMessage; at: Date } | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const { type, timestamp, message } = entry as Record<string, unknown>;
	if (type !== "message" || typeof timestamp !== "string") return undefined;
	const at = Date.parse(timestamp);
	if (!Number.isFinite(at) || at < since) return undefined;
	if (typeof message !== "object" || message === null) return undefined;
	const call = message as CallMessage;
	return call.role === "assistant"
		? { message: call, at: new Date(at) }
		: undefined;
}

function tokensOf(usage: NonNullable<CallMessage["usage"]>): Tokens {
	return {
		"gen_ai.usage.input_tokens": usage.input ?? 0,
		"gen_ai.usage.output_tokens": usage.output ?? 0,
		"gen_ai.usage.cache_read.input_tokens": usage.cacheRead ?? 0,
		"gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite ?? 0,
	};
}

function added(one: Tokens, other: Tokens): Tokens {
	return {
		"gen_ai.usage.input_tokens":
			one["gen_ai.usage.input_tokens"] + other["gen_ai.usage.input_tokens"],
		"gen_ai.usage.output_tokens":
			one["gen_ai.usage.output_tokens"] + other["gen_ai.usage.output_tokens"],
		"gen_ai.usage.cache_read.input_tokens":
			one["gen_ai.usage.cache_read.input_tokens"] +
			other["gen_ai.usage.cache_read.input_tokens"],
		"gen_ai.usage.cache_creation.input_tokens":
			one["gen_ai.usage.cache_creation.input_tokens"] +
			other["gen_ai.usage.cache_creation.input_tokens"],
	};
}

function isTokens(value: unknown): value is Tokens {
	if (typeof value !== "object" || value === null) return false;
	const one = value as Record<string, unknown>;
	return Object.keys(NONE).every((key) => typeof one[key] === "number");
}

/** Whether a value read from outside is usage as this version says it. */
export function isUsage(value: unknown): value is SessionUsage {
	if (typeof value !== "object" || value === null) return false;
	const one = value as Record<string, unknown>;
	const turns = one.turns as Record<string, unknown> | undefined;
	const cost = one["pi.cost.usd"] as Record<string, unknown> | undefined;
	return (
		typeof one.day === "string" &&
		isTokens(one.today) &&
		typeof turns?.today === "number" &&
		typeof cost?.today === "number"
	);
}
