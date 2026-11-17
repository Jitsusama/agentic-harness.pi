/**
 * The signal of the call a command is being run for.
 *
 * Whatever runs commands for a tool is often built once, long before
 * any call: a review provider holds the exec it was handed at
 * registration. Nothing about one call can reach it by argument, so a
 * command it ran went on to its clock whatever the caller said. The
 * call's signal travels with the call instead, and `spawnExec` stops a
 * command started inside it when it fires.
 *
 * Kept on a global symbol rather than in this module, because the
 * call and the command are often in two packages that each install
 * their own copy of this library, and two copies of a module are two
 * stores that never see each other.
 *
 * A call's context outlives it: a promise it chained and never awaited,
 * or a listener it registered, runs later inside it. Once the call is
 * over its signal firing is no reason to stop their work, so a call
 * that has settled reads as the call it was made inside, if that is
 * still running, or none. The signal itself stays in the first store,
 * as older copies of this module read it there, and a second store
 * marks which call it belongs to and whether that has ended.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Where every copy of this module finds the one store. */
const STORE_KEY = Symbol.for("agentic-harness.core/exec/call-signal");

/** Where every copy of this module finds which call it is in. */
const CALL_KEY = Symbol.for("agentic-harness.core/exec/call-signal/call");

/** One call made through `withCallSignal`, and whether it has settled. */
interface Call {
	readonly signal: AbortSignal | undefined;
	/** The call this one was made inside, whose signal stands once this one ends. */
	readonly outer: Call | undefined;
	ended: boolean;
}

/** Where every copy of this module keeps its two stores. */
interface Holder {
	[STORE_KEY]?: AsyncLocalStorage<AbortSignal | undefined>;
	[CALL_KEY]?: AsyncLocalStorage<Call>;
}

/** The store, made by whichever copy of this module asked first. */
function store(): AsyncLocalStorage<AbortSignal | undefined> {
	const holder: Holder = globalThis;
	holder[STORE_KEY] ??= new AsyncLocalStorage();
	return holder[STORE_KEY];
}

/** The calls' store, made by whichever copy of this module asked first. */
function calls(): AsyncLocalStorage<Call> {
	const holder: Holder = globalThis;
	holder[CALL_KEY] ??= new AsyncLocalStorage();
	return holder[CALL_KEY];
}

/** Whether a value is a promise, or anything else awaited as one. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		"then" in value &&
		typeof value.then === "function"
	);
}

/**
 * Run `fn` with `signal` as the signal of every command it starts, and
 * of every command started by anything it awaits.
 */
export function withCallSignal<T>(
	signal: AbortSignal | undefined,
	fn: () => T,
): T {
	const call: Call = { signal, outer: calls().getStore(), ended: false };
	const end = (): void => {
		call.ended = true;
	};
	let result: T;
	try {
		result = calls().run(call, () => store().run(signal, fn));
	} catch (error) {
		end();
		throw error;
	}
	if (result instanceof Promise) {
		// The caller gets the promise that ends the call, rather than the
		// call's own being handled here, so a rejection it drops is still
		// reported as unhandled.
		const ending: Promise<unknown> = result.then(
			(value: unknown) => {
				end();
				return value;
			},
			(error: unknown) => {
				end();
				throw error;
			},
		);
		// The same promise type, settling as the call's own does.
		return ending as T;
	}
	if (isThenable(result)) result.then(end, end);
	else end();
	return result;
}

/**
 * The signal of the call this code is running for, if it has one: the
 * innermost call still running, once the one it ran inside has settled.
 */
export function callSignal(): AbortSignal | undefined {
	const signal = store().getStore();
	let call = calls().getStore();
	// An older copy may have set a signal inside this call without
	// marking a call of its own, so only the call's own signal ends.
	if (call?.signal !== signal) return signal;
	while (call?.ended) call = call.outer;
	return call?.signal;
}
