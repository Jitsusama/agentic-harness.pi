/**
 * Terminal driver registration. Mirrors the refs and people
 * libraries: explicit registration for built-ins, free
 * functions for ad-hoc driver registration, an opt-out
 * clear for tests.
 */

import { BUILTIN_TERMINAL_DRIVERS } from "../internal/terminal/builtins.js";
import { clear, register, unregister } from "../internal/terminal/registry.js";
import type { TerminalDriver } from "./types.js";

/**
 * Register a terminal driver. Overwrites any previously
 * registered driver with the same id.
 */
export function registerTerminalDriver(driver: TerminalDriver): void {
	register(driver);
}

/** Remove a driver from the registry. Idempotent. */
export function unregisterTerminalDriver(id: string): void {
	unregister(id);
}

/**
 * Seed the registry with the built-in drivers: `wezterm`,
 * `tmux` and `fallback`. Idempotent.
 */
export function registerBuiltinTerminalDrivers(): void {
	for (const driver of BUILTIN_TERMINAL_DRIVERS) register(driver);
}

/** Empty the registry. Intended for tests. */
export function clearTerminalDrivers(): void {
	clear();
}
