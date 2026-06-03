/**
 * Handle-type registration: add, remove and seed handle
 * types in the package-wide registry. Symmetric with the
 * refs library's API.
 */

import { BUILTIN_HANDLE_TYPES } from "../internal/people/builtins.js";
import { clear, register, unregister } from "../internal/people/registry.js";
import type { HandleType } from "./types.js";

/**
 * Register a handle type. Overwrites any previously
 * registered type with the same identifier.
 */
export function registerHandleType(handleType: HandleType): void {
	register(handleType);
}

/**
 * Remove a handle type from the registry. Idempotent.
 */
export function unregisterHandleType(type: string): void {
	unregister(type);
}

/**
 * Seed the registry with the built-in handle types:
 * `slack`, `github` and `email`. Idempotent.
 */
export function registerBuiltinHandleTypes(): void {
	for (const ht of BUILTIN_HANDLE_TYPES) register(ht);
}

/**
 * Empty the registry. Intended for tests and `/reload`
 * semantics.
 */
export function clearHandleTypes(): void {
	clear();
}
