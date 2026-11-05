/**
 * The rules for keeping an idle session's hour-long cache entry warm.
 *
 * A session sent with one-hour retention writes its prompt to
 * Anthropic's cache, and the entry lives an hour from its last use.
 * Coming back after that writes the whole prompt again at twice the
 * input price. Sending the session's last request again with a
 * one-token output cap reads the prompt, which refreshes the entry for
 * another hour at the read price, a twentieth of a write.
 *
 * The rules are pi's own (`core/cache-warmer.js` in pi 1.4 and 1.5):
 * warm at nine tenths of the lifetime, keeping ten seconds of margin;
 * give up once a timer runs so late that half of what was left of that
 * margin is gone, since a late warm is likely a full write; and replay
 * only a request whose cache key a smaller output cap leaves alone,
 * which rules out Anthropic's budget-based thinking, where the budget
 * follows the cap and the message cache is keyed on it. pi's warmer
 * stops thirty minutes after the last real request, so for an hour's
 * entry it never warms at all; this keeps warming for up to four
 * lifetimes.
 *
 * Everything here reads the request as it was sent, so the lifetime is
 * the one Anthropic was asked for rather than a guess from settings.
 */

import { isRecord } from "./record.ts";

/** A cache entry asked for with `ttl: "1h"` lives this long. */
export const LONG_CACHE_LIFETIME_MS = 60 * 60_000;

/** One asked for with no `ttl` lives Anthropic's default five minutes. */
const SHORT_CACHE_LIFETIME_MS = 5 * 60_000;

/** At most this many warms after each real request. */
export const MAX_IDLE_WARMS = 4;

/**
 * A warm that writes more than this to the cache did not find its
 * prefix there: a matching replay writes nothing, and this leaves room
 * for the few tokens a provider sometimes counts as written anyway.
 */
export const PREFIX_MISS_WRITE_TOKENS = 2_000;

/** Never closer to expiry than this, whatever share of it is left. */
const MIN_MARGIN_MS = 10_000;

/** Warm at this share of the lifetime. */
const WARM_SHARE = 0.9;

/** The only API whose request shape this reads. */
const ANTHROPIC_MESSAGES = "anthropic-messages";

/**
 * How long the cache entry a request writes lives, from the
 * `cache_control` markers it carries: an hour for any marked `1h`, five
 * minutes for markers with no lifetime, and nothing when it asked for
 * no cache at all.
 */
export function cacheLifetimeOf(payload: unknown): number | undefined {
	let lifetime: number | undefined;
	for (const marker of cacheMarkers(payload)) {
		if (marker.ttl === "1h") return LONG_CACHE_LIFETIME_MS;
		lifetime = SHORT_CACHE_LIFETIME_MS;
	}
	return lifetime;
}

/**
 * When to warm an entry of this lifetime, measured from its last use:
 * at nine tenths of it, but never closer than ten seconds to expiry.
 */
export function warmingDelayMs(lifetimeMs: number): number | undefined {
	if (lifetimeMs <= MIN_MARGIN_MS) return undefined;
	return Math.max(
		1,
		Math.floor(Math.min(lifetimeMs * WARM_SHARE, lifetimeMs - MIN_MARGIN_MS)),
	);
}

/**
 * The latest a warm due at `dueAt` may still go out. A timer can run
 * late after a sleep or a blocked event loop; half of the margin before
 * expiry is kept for that and for the request reaching the provider,
 * and a warm later than this would likely write the whole prompt.
 */
export function warmDeadline(dueAt: number, lifetimeMs: number): number {
	const delay = warmingDelayMs(lifetimeMs) ?? 0;
	return dueAt + Math.floor((lifetimeMs - delay) / 2);
}

/** Whether a request can be sent again to warm its cache, and why not. */
export type Replayable = { ok: true } | { ok: false; reason: string };

/**
 * Whether sending `payload` again with a one-token cap reads the same
 * cache entry. Only Anthropic's messages API is read, and a request with
 * budget-based thinking is refused, since its budget would have to
 * shrink under the cap and the message cache is keyed on it. Adaptive
 * thinking and thinking turned off carry no budget.
 */
export function replayable(payload: unknown, api: string): Replayable {
	if (api !== ANTHROPIC_MESSAGES) {
		return { ok: false, reason: `the ${api} API is not supported` };
	}
	if (!isRecord(payload)) {
		return { ok: false, reason: "the request is not an object" };
	}
	const thinking = payload.thinking;
	if (isRecord(thinking) && thinking.type === "enabled") {
		return {
			ok: false,
			reason: "budget-based thinking keys the cache on the output cap",
		};
	}
	return { ok: true };
}

/** The request to warm with: the same one, with a one-token cap. */
export function warmingPayload(payload: unknown): Record<string, unknown> {
	return { ...(isRecord(payload) ? payload : {}), max_tokens: 1 };
}

/** Whether a warm's usage says it wrote its prompt rather than read it. */
export function prefixMissed(usage: { readonly cacheWrite?: number }): boolean {
	return (usage.cacheWrite ?? 0) > PREFIX_MISS_WRITE_TOKENS;
}

/** Every `cache_control` marker on the system prompt, tools and messages. */
function* cacheMarkers(payload: unknown): Generator<Record<string, unknown>> {
	if (!isRecord(payload)) return;
	for (const part of [payload.system, payload.tools]) {
		if (Array.isArray(part)) yield* markersIn(part);
	}
	if (!Array.isArray(payload.messages)) return;
	for (const message of payload.messages) {
		if (isRecord(message) && Array.isArray(message.content)) {
			yield* markersIn(message.content);
		}
	}
}

function* markersIn(
	blocks: readonly unknown[],
): Generator<Record<string, unknown>> {
	for (const block of blocks) {
		if (isRecord(block) && isRecord(block.cache_control)) {
			yield block.cache_control;
		}
	}
}
