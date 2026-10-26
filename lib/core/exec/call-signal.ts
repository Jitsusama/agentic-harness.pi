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
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Where every copy of this module finds the one store. */
const STORE_KEY = Symbol.for("agentic-harness.core/exec/call-signal");

/** The store, made by whichever copy of this module asked first. */
function store(): AsyncLocalStorage<AbortSignal | undefined> {
	const holder = globalThis as {
		[STORE_KEY]?: AsyncLocalStorage<AbortSignal | undefined>;
	};
	holder[STORE_KEY] ??= new AsyncLocalStorage();
	return holder[STORE_KEY];
}

/**
 * Run `fn` with `signal` as the signal of every command it starts, and
 * of every command started by anything it awaits.
 */
export function withCallSignal<T>(
	signal: AbortSignal | undefined,
	fn: () => T,
): T {
	return store().run(signal, fn);
}

/** The signal of the call this code is running for, if it has one. */
export function callSignal(): AbortSignal | undefined {
	return store().getStore();
}
