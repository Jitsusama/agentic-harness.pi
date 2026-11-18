/**
 * A run the host carries on after a restart reads busy to extensions, as a
 * run pi's session started does.
 *
 * pi's session reads itself idle unless it started the run that streams.
 * The host carries a cut-off run on from the agent's recover, which pi's
 * session never started, so an extension's `ctx.isIdle()` read true while
 * that run streamed. On 18 November compaction-workflow compacted on that
 * reading with no resume; pi's compaction aborts the run first, and the
 * carried run stopped with nothing to start it again.
 *
 * Every extension runner pi builds, a reload's included, binds its context
 * through `ExtensionRunner.prototype.bindCore`, so wrapping it once in the
 * host's process reaches each: the context reads idle only when the session
 * says so and the agent holds no run's signal. The agent's signal is live
 * exactly while it streams, the host's agent and pi's own alike, so a run
 * of pi's own reads as it did. The session's own idleness, which pi's
 * waits read, is left alone.
 */
import type { HostPiModules } from "./host-pi.ts";

/** Marks a prototype whose bindCore is already wrapped, so a second opening wraps nothing. */
const WRAPPED = Symbol.for("pi-host.busy-while-carried");

interface ContextActions {
	readonly isIdle: () => boolean;
	readonly getSignal: () => AbortSignal | undefined;
	readonly [action: string]: unknown;
}

type BindCore = (
	this: unknown,
	actions: unknown,
	contextActions: ContextActions,
	...rest: unknown[]
) => unknown;

/** Make every extension context in this process read a run the host carries on as busy. */
export function readCarriedRunsBusy(modules: HostPiModules): void {
	const runner = modules.codingAgent.ExtensionRunner;
	if (typeof runner !== "function")
		throw new Error("The host's pi exports no ExtensionRunner");
	const prototype: unknown = runner.prototype;
	if (typeof prototype !== "object" || prototype === null)
		throw new Error("The host's pi's ExtensionRunner has no prototype");
	if (Reflect.get(prototype, WRAPPED) === true) return;
	const bindCore: unknown = Reflect.get(prototype, "bindCore");
	if (!isBindCore(bindCore))
		throw new Error("The host's pi's ExtensionRunner has no bindCore");
	const wrapped: BindCore = function (
		this: unknown,
		actions,
		contextActions,
		...rest
	) {
		return bindCore.call(
			this,
			actions,
			{
				...contextActions,
				isIdle: () =>
					contextActions.isIdle() && contextActions.getSignal() === undefined,
			},
			...rest,
		);
	};
	Reflect.set(prototype, "bindCore", wrapped);
	Reflect.set(prototype, WRAPPED, true);
}

function isBindCore(value: unknown): value is BindCore {
	return typeof value === "function";
}
