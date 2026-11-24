/**
 * Warming a parked conversation's cache. A session warms its own idle
 * cache entry (extensions/compaction-workflow/warm.ts), but parking
 * ends the session after an hour idle and its warming with it, so a
 * wake two hours or more later wrote the whole conversation to the
 * cache again: 80 such wakes on 11 November, about $110.
 *
 * As it parks, the session writes its warming's carry to disk
 * (lib/internal/cache/warming-carry.ts). The host takes the schedule on from
 * there, as the session would have kept it: a warm 54 minutes after the
 * entry was last refreshed, then 54 minutes after each warm, at most
 * four in all counting the session's own, each sending the last
 * request again with a one-token cap. Each warm rewrites the carry, so
 * the session's next start, or the host after a restart, carries on
 * from it, and is kept for that start to record, since only the
 * session writes its log.
 *
 * What stops it: the conversation waking or closing (`stop`, before
 * its session starts and takes the carry), the carry going, a warm that
 * wrote more than 2,000 tokens (its prefix was gone, so the entry is
 * as dear to keep as to rebuild), a warm that failed twice, a timer so
 * late the entry has probably expired, warming switched off, or a carry
 * asking for no hour's cache. A warm still out when the conversation
 * wakes is dropped unrecorded rather than holding up the wake.
 *
 * No warm goes while a call is on, since each sends a whole
 * conversation up a line the call needs: "his video this morning
 * starved on upload" (WCJQSG, 12 November 2026). A warm due during a
 * call looks again every 15 seconds and goes once the call ends, if
 * its entry still lives; a call that outlasts the entry ends the
 * warming, said through `held`, since a later warm would only pay the
 * rewrite early. A held warm has sent nothing, so it isn't in flight
 * and holds up no restart; the next host finds it still due in the
 * carry and sends it once the call ends.
 *
 * Every read and write of a carry goes off the host's thread. Each
 * holds the whole conversation, and on 23 November the background
 * host's loop held 18 times in a day, up to 15 s at once, opening and
 * renaming carries while the disk waited on its own commits. Once a
 * warm has gone, a wake can land before what it did is kept, so each
 * step looks again before it runs. The warm is kept for the ledger
 * first, since it was paid for whatever follows. The warmed carry is
 * then written, and dropped unrenamed once a wake lands, since the
 * waking session owns the carry then: a rename already under way puts
 * the newer carry in place for its start, and one landing after the
 * start took it leaves a carry the next park writes over.
 */

import {
	cacheLifetimeOf,
	LONG_CACHE_LIFETIME_MS,
	MAX_IDLE_WARMS,
	prefixMissed,
	replayable,
	warmDeadline,
	warmingDelayMs,
	warmingPayload,
} from "../../lib/internal/cache/cache-warming.ts";
import { CALL_LOOK_MS } from "../../lib/internal/cache/calls.ts";
import {
	addPendingWarmOff,
	readWarmingCarryOff,
	type WarmingCarry,
	writeWarmingCarryOff,
} from "../../lib/internal/cache/warming-carry.ts";
import type { ModelRuntime } from "./pi-session.ts";

/** A failed warm is tried once more after this, if its deadline allows. */
const RETRY_AFTER_MS = 30_000;

/** What a warm's reply says it cost, as the spend ledger reads a side call. */
export interface WarmReply {
	readonly provider: string;
	readonly model: string;
	readonly responseModel?: string;
	readonly usage: { readonly cacheWrite: number } & Record<string, unknown>;
}

/** How a warm went. */
export type WarmSent =
	| { readonly ok: true; readonly message: WarmReply }
	| { readonly ok: false; readonly reason: string };

/** What warms parked conversations. */
export interface ParkedWarming {
	/** It parked: warm its carry on, from where its own warming left off. */
	start(sessionId: string): void;
	/** It wakes or closes: nothing more is sent or written for it. */
	stop(sessionId: string): void;
	/** Warms out now, which a restart waits for as it waits for jobs. */
	inFlight(): number;
}

/** Where the warming keeps each carry and the warms sent on it. */
export interface CarryFiles {
	read(dir: string, sessionId: string): Promise<WarmingCarry | null>;
	/** Write a carry whole, unless `signal` aborts before it is in place; whether it was. */
	write(
		dir: string,
		carry: WarmingCarry,
		signal: AbortSignal,
	): Promise<boolean>;
	addPending(
		dir: string,
		sessionId: string,
		record: Readonly<Record<string, unknown>>,
	): Promise<void>;
}

/** The carries on disk, every step off the thread. */
const OFF_THREAD: CarryFiles = {
	read: readWarmingCarryOff,
	write: writeWarmingCarryOff,
	addPending: addPendingWarmOff,
};

/** One parked conversation's warming. */
interface Warming {
	readonly controller: AbortController;
	timer?: ReturnType<typeof setTimeout>;
	retried: boolean;
	/** When a call first held its next warm back. */
	heldSince?: number;
}

/**
 * Warm the carries under `carries` as their conversations park,
 * keeping each warm under `pending`. `send` sends a carry's request
 * again with a one-token cap, as the conversation would.
 */
export function parkedWarming(options: {
	readonly carries: string;
	readonly pending: string;
	readonly send: (
		carry: WarmingCarry,
		signal: AbortSignal,
	) => Promise<WarmSent>;
	readonly enabled: () => Promise<boolean>;
	readonly callOn: () => Promise<boolean>;
	/** A call outlasted the entry, so its warming ended unsent. */
	readonly held: (sessionId: string) => void;
	readonly report: (error: unknown) => void;
	/** Where carries are kept; on disk off the thread unless a test says. */
	readonly files?: CarryFiles;
}): ParkedWarming {
	const { carries, pending, report } = options;
	const files = options.files ?? OFF_THREAD;
	const warmings = new Map<string, Warming>();
	let flying = 0;

	const stop = (sessionId: string) => {
		const warming = warmings.get(sessionId);
		if (!warming) return;
		if (warming.timer !== undefined) clearTimeout(warming.timer);
		warming.controller.abort();
		warmings.delete(sessionId);
	};

	/** Stop `warming` if it is still the conversation's, never a later one. */
	const stopIf = (sessionId: string, warming: Warming) => {
		if (warmings.get(sessionId) === warming) stop(sessionId);
	};

	/** When its next warm falls due and when that is too late, or nothing to warm. */
	const due = (carry: WarmingCarry) => {
		if (carry.warms >= MAX_IDLE_WARMS) return undefined;
		const lifetimeMs = cacheLifetimeOf(carry.payload);
		if (lifetimeMs !== LONG_CACHE_LIFETIME_MS) return undefined;
		const delayMs = warmingDelayMs(lifetimeMs);
		if (delayMs === undefined) return undefined;
		const dueAt = carry.refreshedAt + delayMs;
		const deadline = warmDeadline(dueAt, lifetimeMs);
		return Date.now() > deadline ? undefined : { dueAt, deadline };
	};

	const schedule = (sessionId: string, warming: Warming, at: number) => {
		warming.timer = setTimeout(
			() =>
				void warm(sessionId, warming).catch((error: unknown) => {
					// A rejection from a timer has nobody above it; warming is
					// never worth taking the host down.
					stopIf(sessionId, warming);
					report(error);
				}),
			Math.max(0, at - Date.now()),
		);
		warming.timer.unref?.();
	};

	const warm = async (sessionId: string, warming: Warming) => {
		warming.timer = undefined;
		const carry = await files.read(carries, sessionId);
		const next = carry ? due(carry) : undefined;
		if (!carry || !next || !(await options.enabled())) {
			stopIf(sessionId, warming);
			return;
		}
		if (warmings.get(sessionId) !== warming) return;
		if (await options.callOn()) {
			if (warmings.get(sessionId) !== warming) return;
			if (Date.now() + CALL_LOOK_MS > next.deadline) {
				stop(sessionId);
				options.held(sessionId);
				return;
			}
			warming.heldSince ??= Date.now();
			schedule(sessionId, warming, Date.now() + CALL_LOOK_MS);
			return;
		}
		if (warmings.get(sessionId) !== warming) return;
		const sentAt = Date.now();
		const heldForCallMs =
			warming.heldSince === undefined ? undefined : sentAt - warming.heldSince;
		warming.heldSince = undefined;
		flying += 1;
		try {
			await sendAndKeep(sessionId, warming, carry, {
				sentAt,
				deadline: next.deadline,
				heldForCallMs,
			});
		} finally {
			flying -= 1;
		}
	};

	/**
	 * Send the warm and keep what it did, its writes counted in flight
	 * with it, so a restart waits for the carry to land whole.
	 */
	const sendAndKeep = async (
		sessionId: string,
		warming: Warming,
		carry: WarmingCarry,
		when: {
			readonly sentAt: number;
			readonly deadline: number;
			readonly heldForCallMs: number | undefined;
		},
	) => {
		const { sentAt, deadline, heldForCallMs } = when;
		const sent = await options.send(carry, warming.controller.signal);
		// It woke or closed while the warm was out: its session owns the
		// carry now, and nothing more is written.
		const woke = () => warming.controller.signal.aborted;
		if (woke()) return;
		if (!sent.ok) {
			if (!warming.retried && Date.now() + RETRY_AFTER_MS <= deadline) {
				warming.retried = true;
				schedule(sessionId, warming, Date.now() + RETRY_AFTER_MS);
				return;
			}
			stop(sessionId);
			report(`Parked warm of ${sessionId} failed: ${sent.reason}`);
			return;
		}
		warming.retried = false;
		const missed = prefixMissed(sent.message.usage);
		const warmed: WarmingCarry = {
			...carry,
			refreshedAt: sentAt,
			warms: missed ? MAX_IDLE_WARMS : carry.warms + 1,
		};
		// Kept before the carry, since it was paid for: a wake landing as
		// it is appended has its start record it, or the start after.
		await files.addPending(pending, sessionId, {
			provider: sent.message.provider,
			model: sent.message.responseModel ?? sent.message.model,
			usage: sent.message.usage,
			warm: carry.warms + 1,
			sinceRequestMs: sentAt - carry.at,
			sentAt,
			parked: true,
			...(heldForCallMs === undefined ? {} : { heldForCallMs }),
		});
		if (woke()) return;
		const written = await files.write(
			carries,
			warmed,
			warming.controller.signal,
		);
		if (!written || woke()) return;
		const after = due(warmed);
		if (after) schedule(sessionId, warming, after.dueAt);
		else stop(sessionId);
	};

	return {
		start(sessionId) {
			stop(sessionId);
			// Taken as its own before its carry is read, so a wake while it
			// reads stops it.
			const warming: Warming = {
				controller: new AbortController(),
				retried: false,
			};
			warmings.set(sessionId, warming);
			void files
				.read(carries, sessionId)
				.then((carry) => {
					if (warmings.get(sessionId) !== warming) return;
					const next = carry ? due(carry) : undefined;
					if (next) schedule(sessionId, warming, next.dueAt);
					else stop(sessionId);
				})
				.catch((error: unknown) => {
					// As a timer's, a read's rejection has nobody above it.
					stopIf(sessionId, warming);
					report(error);
				});
		},
		stop,
		inFlight: () => flying,
	};
}

/**
 * Send a carry's request again with a one-token cap through pi's model
 * runtime, which resolves the model's endpoint and the conversation's
 * key as its own turns did, so the warm reaches the same cache.
 */
export async function warmThrough(
	runtime: ModelRuntime,
	carry: WarmingCarry,
	signal: AbortSignal,
): Promise<WarmSent> {
	const model = runtime.getModel(carry.provider, carry.modelId);
	if (!model)
		return { ok: false, reason: `no model ${carry.provider}/${carry.modelId}` };
	const replay = replayable(carry.payload, model.api);
	if (!replay.ok) return replay;
	try {
		const message = await runtime.completeSimple(
			model,
			{ messages: [] },
			{
				headers: carry.headers,
				sessionId: carry.sessionId,
				maxTokens: 1,
				maxRetries: 0,
				signal,
				onPayload: () => warmingPayload(carry.payload),
			},
		);
		if (message.stopReason === "error" || message.stopReason === "aborted")
			return { ok: false, reason: message.errorMessage ?? message.stopReason };
		return { ok: true, message };
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
