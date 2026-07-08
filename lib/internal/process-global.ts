/**
 * Process-global singletons shared across extension module
 * instances.
 *
 * Pi loads each extension as its own module instance, so a
 * module-level `const registry = new Map()` is not one registry:
 * each extension that imports the module gets its own. Anything
 * one extension writes and another reads (a recorder sink, a
 * prompt contributor, an LSP backend, the shared browser) must
 * therefore live on `globalThis` under a shared key rather than
 * in a module variable. `Symbol.for` gives every module instance
 * the same key, and `globalThis` is shared across them, so the
 * value is genuinely one per process.
 */

/**
 * Get the process-global value for `key`, creating it once with
 * `create` on first access. Every caller in the process, in any
 * extension module instance, receives the same value.
 */
export function processGlobal<T>(key: string, create: () => T): T {
	const symbol = Symbol.for(key);
	const store = globalThis as Record<symbol, T | undefined>;
	// Test presence with `in`, not truthiness, so a value that is
	// legitimately undefined or falsy is still created only once.
	if (!(symbol in store)) store[symbol] = create();
	return store[symbol] as T;
}
