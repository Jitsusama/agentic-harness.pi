/**
 * Driver resolution: pick a usable terminal driver for the
 * current environment.
 *
 * Resolution order:
 *
 * 1. The driver named in the `preferred` argument, when its
 *    `available()` returns true.
 * 2. Each registered driver in registration order, the
 *    first whose `available()` returns true wins.
 * 3. `undefined` when no driver is available (callers fall
 *    back to printing instructions, or refuse).
 */

import { get, list } from "../internal/terminal/registry.js";
import type { TerminalDriver, TerminalRequest } from "./types.js";

/** Look up a driver by id, or `undefined`. */
export function getTerminalDriver(id: string): TerminalDriver | undefined {
	return get(id);
}

/** Snapshot of every registered driver. */
export function listTerminalDrivers(): TerminalDriver[] {
	return list();
}

/**
 * Resolve the driver to use for a spawn. Preferred wins
 * when available; otherwise the first registered driver
 * whose `available()` says yes.
 */
export async function resolveDriver(
	preferred?: string,
): Promise<TerminalDriver | undefined> {
	if (preferred) {
		const driver = get(preferred);
		if (driver && (await driver.available())) return driver;
	}
	for (const driver of list()) {
		if (await driver.available()) return driver;
	}
	return undefined;
}

/**
 * Convenience: resolve a driver and dispatch a request in
 * one call. Throws when no driver is available.
 */
export async function spawnTerminal(
	request: TerminalRequest,
	preferred?: string,
): Promise<TerminalDriver> {
	const driver = await resolveDriver(preferred);
	if (!driver) {
		throw new Error(
			"No terminal driver available. Register one or seed the built-ins with `registerBuiltinTerminalDrivers`.",
		);
	}
	await driver.spawn(request);
	return driver;
}
