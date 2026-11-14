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
 * call under, which is the one pi hands these operations.
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
import { CALL_VARIABLE } from "../../lib/internal/shell/reap.ts";
import type { JobCarry } from "../../lib/jobs/index.ts";
import { COMMAND_STUB, KEEP_VARIABLE, KEEPING_STUB } from "./command-line.ts";

/** How much output passes between looks at whether `.out` is full. */
const LOOK_EVERY_BYTES = KEPT_BYTES / 16;

const MS_PER_SECOND = 1000;

/** What the operations need, for tests to stand in for. */
export interface KeepingOptions {
	/**
	 * Whether a call can be kept: GNU tee, bash, no pi-spawner; asked with
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
				const path = options.folder ? makeKept(options.folder()) : makeKept();
				const startedAt = now();
				const kept: KeptCall = {
					path,
					mark: call.env?.[CALL_VARIABLE],
					startedAt,
					deadline:
						call.timeout !== undefined && call.timeout > 0
							? startedAt + call.timeout * MS_PER_SECOND
							: undefined,
					handed: false,
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
				try {
					return await ops.exec(KEEPING_STUB, cwd, {
						...call,
						onData,
						env: { ...(call.env ?? process.env), [KEEP_VARIABLE]: path },
					});
				} finally {
					if (!kept.handed) removeKept(path);
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
					// A host's reaper spares it until its end is said elsewhere.
					markCarried(kept.path, kept.mark);
				},
			};
		},
	};
}
