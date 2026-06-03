/**
 * Refs registration: add, remove and seed ref types in the
 * package-wide registry.
 *
 * The registry is module-level; a single `RefType` per
 * identifier wins. Re-registering the same identifier
 * replaces the previous definition. The refs library does
 * not auto-register the built-ins: callers (e.g. the quest
 * extension) call `registerBuiltinRefTypes()` on activate
 * to opt in.
 */

import { BUILTIN_REF_TYPES } from "../internal/refs/builtins.js";
import { clear, register, unregister } from "../internal/refs/registry.js";
import type { RefType } from "./types.js";

/**
 * Register a ref type. Overwrites any previously registered
 * type with the same `type` identifier.
 */
export function registerRefType(refType: RefType): void {
	register(refType);
}

/**
 * Remove a ref type from the registry. Idempotent: removing
 * an absent type is a no-op.
 */
export function unregisterRefType(type: string): void {
	unregister(type);
}

/**
 * Seed the registry with the built-in ref types:
 * `github-issue`, `github-pr`, `github-repo`,
 * `slack-message` and `slack-thread`. Idempotent;
 * re-registers each definition on every call.
 */
export function registerBuiltinRefTypes(): void {
	for (const rt of BUILTIN_REF_TYPES) register(rt);
}

/**
 * Empty the registry. Intended for tests and `/reload`
 * semantics; not for normal extension code.
 */
export function clearRefTypes(): void {
	clear();
}
