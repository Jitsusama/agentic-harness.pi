/**
 * Each bash call kept on disk while it runs, so a move can carry it.
 *
 * pi's operations run the stub the spawn hook left (command-line.ts);
 * where the machine can keep a call past its pi, these run the keeping
 * stub in its place, with the call's own path in the files' folder
 * (lib/internal/shell/kept.ts). A call ending here takes its files with
 * it: its end is said from what pi read, so they are no longer needed.
 * One handed to another process leaves them for that process, marked
 * carried so the host that started it doesn't reap it.
 *
 * The hand-off finds its call's files through the signal it ran the
 * call under, which is the one these operations are handed: pi's own,
 * or for a call timed from its turn, the one timed-keeping.ts names.
 *
 * A kept call's time limit is held here rather than by the operations
 * below, so a hand-off can lift it: the pi that takes the call up holds
 * its deadline from then (carried.ts), and one killed here at a limit
 * no longer its own would end with no status written, read there as lost.
 */

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { CarriedShell } from "../../lib/internal/shell/carried.ts";
import {
	KEPT_BYTES,
	makeKept,
	markCarried,
	pidOf,
	removeKept,
	rollIfFull,
} from "../../lib/internal/shell/kept.ts";
import {
	disownKeptJob,
	forgetOwnKeptJob,
} from "../../lib/internal/shell/kept-jobs.ts";
import { CALL_VARIABLE } from "../../lib/internal/shell/reap.ts";
import { MAX_TIMEOUT_MS } from "../../lib/internal/shell/spawner.ts";
import type { JobCarry } from "../../lib/jobs/index.ts";
import { COMMAND_STUB, KEEP_VARIABLE, KEEPING_STUB } from "./command-line.ts";

/** How much output passes between looks at whether `.out` is full. */
const LOOK_EVERY_BYTES = KEPT_BYTES / 16;

const MS_PER_SECOND = 1000;

/** What the operations need, for tests to stand in for. */
export interface KeepingOptions {
	/**
	 * Whether a call can be kept: GNU tee, bash, and no pi-spawner or one
	 * that spares kept commands when pi goes; asked with
	 * the call's environment when it has one, since its PATH finds the tee
	 * it runs, and waited on without holding pi's loop.
	 */
	readonly can: (env?: NodeJS.ProcessEnv) => boolean | Promise<boolean>;
	/** Where the calls' files go. */
	readonly folder?: () => string;
	readonly now?: () => number;
}

/** pi's operations with each call kept, and how a call is carried. */
export interface Keeping {
	readonly operations: BashOperations;
	/** How the call run under `signal` is handed on, if calls are kept. */
	carryOf(signal: AbortSignal): JobCarry | undefined;
}

interface KeptCall {
	readonly path: string;
	readonly mark: string | undefined;
	readonly startedAt: number;
	readonly deadline: number | undefined;
	handed: boolean;
	/** Lifts the call's time limit here, once another process holds it. */
	disarm: () => void;
}

/**
 * The call's time limit in milliseconds, where it is one these
 * operations hold; one pi would refuse is left to the operations below.
 */
function heldLimit(timeout: number | undefined): number | undefined {
	if (timeout === undefined || !Number.isFinite(timeout) || timeout <= 0)
		return undefined;
	const limit = timeout * MS_PER_SECOND;
	return limit <= MAX_TIMEOUT_MS ? limit : undefined;
}

/** `ops`, keeping each call it runs while `options.can` says it may. */
export function keepsOnDisk(
	ops: BashOperations,
	options: KeepingOptions,
): Keeping {
	const now = options.now ?? Date.now;
	const calls = new WeakMap<AbortSignal, KeptCall>();
	// The calls whose own environment said they can't be kept.
	const unkept = new WeakSet<AbortSignal>();
	return {
		operations: {
			async exec(command, cwd, call) {
				if (command !== COMMAND_STUB) return await ops.exec(command, cwd, call);
				if (!(await options.can(call.env))) {
					if (call.signal) unkept.add(call.signal);
					return await ops.exec(command, cwd, call);
				}
				const limit = heldLimit(call.timeout);
				if (limit === undefined && call.timeout !== undefined) {
					// Refused below as pi refuses it, so there's nothing to keep.
					if (call.signal) unkept.add(call.signal);
					return await ops.exec(command, cwd, call);
				}
				const path = await (options.folder
					? makeKept(options.folder())
					: makeKept());
				const startedAt = now();
				// Stops the call on pi's abort, or at its limit while it is still
				// this pi's.
				const stopping = new AbortController();
				const stop = () => stopping.abort();
				let timedOut = false;
				const timer =
					limit === undefined
						? undefined
						: setTimeout(() => {
								timedOut = true;
								stop();
							}, limit);
				const kept: KeptCall = {
					path,
					mark: call.env?.[CALL_VARIABLE],
					startedAt,
					deadline: limit === undefined ? undefined : startedAt + limit,
					handed: false,
					disarm: () => clearTimeout(timer),
				};
				if (call.signal) calls.set(call.signal, kept);
				let since = 0;
				const onData = (data: Buffer) => {
					since += data.length;
					if (since >= LOOK_EVERY_BYTES) {
						since = 0;
						rollIfFull(path);
					}
					call.onData(data);
				};
				if (call.signal?.aborted) stop();
				else call.signal?.addEventListener("abort", stop, { once: true });
				const { timeout: _held, ...rest } = call;
				try {
					const ended = await ops.exec(KEEPING_STUB, cwd, {
						...rest,
						signal: stopping.signal,
						onData,
						env: { ...(call.env ?? process.env), [KEEP_VARIABLE]: path },
					});
					if (timedOut) throw new Error(`timeout:${call.timeout}`);
					return ended;
				} catch (error) {
					if (timedOut) throw new Error(`timeout:${call.timeout}`);
					throw error;
				} finally {
					clearTimeout(timer);
					call.signal?.removeEventListener("abort", stop);
					// Its job's record goes before it settles, so a pi gone just
					// after never leaves one for its next start to take up and say
					// the end of again. It goes off the thread, and only when this
					// process wrote one: most calls have none, and asking the disk
					// for a name that isn't there held every conversation's loop for
					// seconds when the disk was busy. The call waits for it a few
					// seconds at most, so a wedged disk never holds it open, and no
					// longer than a stop the person asks for meanwhile, its files'
					// removal below taking the record; a session's close meanwhile
					// leaves it to the removal, and a pi exiting first takes it back
					// on the thread as it goes (kept.ts). While it goes the call can
					// still be carried, so a move or a host's stop meeting it then
					// carries it, its end said where it lands, rather than finding a
					// job neither carriable nor ended and stopping it. Not one this
					// pi stopped or timed out: it is said stopped here, and a taker
					// would call it lost. Its files go below, record first, not
					// waited for, as a wedged disk would hold the stop the person
					// asked for. Its shell is killed, so a record a pi gone at once
					// leaves reads as a call gone unsaid, which a start only
					// removes, unless the shell wrote its end just before the stop,
					// when that start says the end it wrote.
					const stopped = stopping.signal.aborted;
					if (!(kept.handed || stopped))
						await forgetOwnKeptJob(
							path,
							call.signal ? { signal: call.signal } : {},
						);
					// Handed on meanwhile, its files are the taker's. Otherwise ended
					// here, so nothing may carry or hand it on while they go, which
					// takes turns of the loop, and from here to its settle none
					// passes: its job is said ended at once, and its files go just
					// after, not waited for. It ran here and was never handed on, so
					// nothing marked it carried, and a pi exiting first asks after
					// only the record it holds.
					if (!kept.handed) {
						if (call.signal) calls.delete(call.signal);
						void removeKept(path, { neverHanded: true });
					}
				}
			},
		},
		carryOf(signal) {
			// One still being asked about has a carry, which has nothing to
			// take up until the call is kept, and holds a move until then.
			if (unkept.has(signal)) return undefined;
			return {
				what(): CarriedShell | undefined {
					const kept = calls.get(signal);
					if (!kept || kept.handed || kept.mark === undefined) return undefined;
					const pid = pidOf(kept.path);
					if (pid === undefined) return undefined;
					return {
						kind: "shell",
						keep: kept.path,
						pid,
						mark: kept.mark,
						startedAt: kept.startedAt,
						...(kept.deadline !== undefined ? { deadline: kept.deadline } : {}),
					};
				},
				handed() {
					const kept = calls.get(signal);
					if (!kept) return;
					kept.handed = true;
					kept.disarm();
					// Its record is the taker's to write again and take back; one
					// set aside by its removal meanwhile is put back.
					disownKeptJob(kept.path);
					// A host's reaper spares it until its end is said elsewhere.
					markCarried(kept.path, kept.mark);
				},
			};
		},
	};
}
