/**
 * One screen, one gate on it at a time.
 *
 * Pi's `ctx.ui.custom` supports one active component at a time. When an
 * agent fires several write calls in one turn their handlers run
 * concurrently and each tries to mount its own gate: the first wins the
 * UI and the rest either hang or silently bypass review, which is the bad
 * one, since a gate nobody saw still counts as approval.
 *
 * Slack worked this out first and kept the queue private, which held
 * while it was the only extension asking. It is not: a review tool call
 * can land while a Slack gate is already open.
 *
 * The queue lives here rather than in any one integration because what it
 * protects, the screen, belongs to none of them. For the same reason it
 * does not belong to this copy of the library either: two packages that
 * each carry a `lib/ui` still share one screen. So the queue is kept on a
 * process-global key as a small protocol, a version number and a fixed
 * method set, and the first copy to load installs it. Every later copy
 * joins the one it finds, whatever version installed it, since replacing
 * a live queue would strand whoever is waiting in it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Handed to the gate holding the screen. */
export interface GateHold {
	/**
	 * Give the screen to the next gate now, before the holder's work
	 * settles. For whoever sees the panel leave by a path that never
	 * settles its promise, so a panel pi dropped cannot hold the queue
	 * for good. Call it only once the panel is off screen, or two
	 * panels are up at once. Idempotent.
	 */
	release(): void;
}

/** How a caller may bound its wait for the screen. */
export interface GateOptions {
	/**
	 * Stops the wait. A gate stopped while it queues rejects at once with
	 * an `AbortError` and never mounts. One already on screen keeps the
	 * screen until its panel is gone, since only the panel knows how to
	 * close itself.
	 */
	signal?: AbortSignal;
}

/**
 * The protocol on the global key. Its shape is a contract between copies
 * at different versions: add methods under a new version, never change
 * these.
 */
interface GateQueueProtocol {
	readonly version: number;
	run<T>(fn: (hold: GateHold) => Promise<T>, options?: GateOptions): Promise<T>;
}

/** The key every copy looks for. The string is the contract; keep it. */
const QUEUE_KEY = Symbol.for("agentic-harness.gate-queue");

/** The protocol version this copy installs. */
const PROTOCOL_VERSION = 1;

/**
 * Run a gate prompt with exclusive access to the UI.
 *
 * Callers wait for the gate in flight to let go of the screen, by
 * settling or by releasing its hold, before their own prompt mounts.
 * Order is the order they asked in. A gate asked for by the gate on
 * screen, such as a prompt inside a wrapper that already queued, is the
 * same panel and runs at once.
 */
export function runGate<T>(
	fn: (hold: GateHold) => Promise<T>,
	options?: GateOptions,
): Promise<T> {
	return sharedQueue().run(fn, options);
}

/**
 * Run a section of several prompts, such as a setup wizard, with the
 * screen held from its first prompt to its last, so no other gate mounts
 * between two of its steps or over a dialog pi draws itself. Its own
 * prompts run at once inside the hold. Stopped while still waiting for
 * the screen, it answers `stopped` without running.
 */
export async function holdScreen<T>(
	signal: AbortSignal | undefined,
	stopped: T,
	section: () => Promise<T>,
): Promise<T> {
	try {
		return await runGate(section, { signal });
	} catch (error) {
		if (
			signal?.aborted &&
			error instanceof Error &&
			error.name === "AbortError"
		)
			return stopped;
		throw error;
	}
}

function sharedQueue(): GateQueueProtocol {
	const g = globalThis as Record<symbol, unknown>;
	const found = g[QUEUE_KEY];
	if (isProtocol(found)) return found;
	const installed = createQueue();
	g[QUEUE_KEY] = installed;
	return installed;
}

function isProtocol(value: unknown): value is GateQueueProtocol {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { version?: unknown; run?: unknown };
	return (
		typeof candidate.version === "number" &&
		candidate.version >= 1 &&
		typeof candidate.run === "function"
	);
}

/** One hold on the screen, and whether it still holds it. */
interface Holder {
	holding: boolean;
}

function createQueue(): GateQueueProtocol {
	// The tail of the chain: each arrival waits for it and becomes it.
	// It resolves when a holder lets go, never rejects, so one failed
	// gate cannot poison the queue for whoever is next.
	let tail: Promise<void> = Promise.resolve();
	// Which hold the running code sits inside, carried across its awaits,
	// so a gate asked for from inside the gate on screen is recognized.
	const within = new AsyncLocalStorage<Holder>();

	function run<T>(
		fn: (hold: GateHold) => Promise<T>,
		options: GateOptions = {},
	): Promise<T> {
		const { signal } = options;
		if (signal?.aborted) return Promise.reject(stopped(signal));

		// Only while that holder still holds: work started inside a gate
		// can outlive it, and asking afterwards is a new arrival.
		const outer = within.getStore();
		if (outer?.holding) {
			try {
				return fn({ release() {} });
			} catch (error) {
				return Promise.reject(error);
			}
		}

		let letGo: () => void = () => {};
		const done = new Promise<void>((resolve) => {
			letGo = resolve;
		});
		const turn = tail;
		tail = done;

		const holder: Holder = { holding: false };
		const release = (): void => {
			holder.holding = false;
			letGo();
		};

		return new Promise<T>((resolve, reject) => {
			// Listening only while queued: the listener comes off as the gate
			// mounts, and a mounted gate keeps the screen until it is gone.
			const onAbort = (): void => {
				// Leave the line but keep its place: whoever is behind
				// waits for the one ahead, not for this caller.
				turn.then(release);
				reject(signal ? stopped(signal) : new Error("Stopped."));
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			turn.then(() => {
				if (signal?.aborted) return;
				signal?.removeEventListener("abort", onAbort);
				holder.holding = true;
				let section: Promise<T>;
				try {
					section = within.run(holder, () => fn({ release }));
				} catch (error) {
					release();
					reject(error);
					return;
				}
				section.then(
					(value) => {
						release();
						resolve(value);
					},
					(error: unknown) => {
						release();
						reject(error);
					},
				);
			});
		});
	}

	return { version: PROTOCOL_VERSION, run };
}

function stopped(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	if (reason instanceof Error && reason.name === "AbortError") return reason;
	const error = new Error("Stopped while waiting for the screen.");
	error.name = "AbortError";
	return error;
}
