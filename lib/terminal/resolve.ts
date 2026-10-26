/**
 * Looking drivers up, and the older one-call spawn API.
 *
 * `openTerminal` and `openTerminals` in `open.ts` are the way to open
 * a shell: they discover, take the person's settings and plan. The
 * functions here stay for callers written before them, and are built
 * on the same planning, so they no longer pick a terminal whose binary
 * happens to be installed over the one the session sits in.
 */

import { linuxAncestry } from "../core/internal/terminal/ancestry.ts";
import { get, list } from "../core/internal/terminal/registry.ts";
import { sightChain } from "./discover.ts";
import { currentPlatform, openTerminal } from "./open.ts";
import type {
	TerminalDriver,
	TerminalLivenessCapability,
	TerminalRequest,
	TerminalSessionHandle,
	TerminalTypeCapability,
} from "./types.ts";

/** Look up a driver by id, or `undefined`. */
export function getTerminalDriver(id: string): TerminalDriver | undefined {
	return get(id);
}

/** Snapshot of every registered driver. */
export function listTerminalDrivers(): TerminalDriver[] {
	return list();
}

/** Whether a driver implements the optional liveness capability. */
function hasLivenessCapability(
	driver: TerminalDriver,
): driver is TerminalDriver & TerminalLivenessCapability {
	return (
		typeof (driver as Partial<TerminalLivenessCapability>).probe ===
			"function" &&
		typeof (driver as Partial<TerminalLivenessCapability>).identifyCurrent ===
			"function"
	);
}

function hasTypeCapability(
	driver: TerminalDriver,
): driver is TerminalDriver & TerminalTypeCapability {
	return (
		typeof (driver as Partial<TerminalTypeCapability>).typeInto === "function"
	);
}

/**
 * Resolve the driver that can type into an existing surface, for a
 * recorded driver id. Undefined when that driver cannot, which a
 * caller must treat as a refusal rather than a reason to fall back:
 * the fallback is running the command without a login shell, and that
 * is the failure the capability exists to avoid.
 */
export function getTypeProvider(
	driverId: string,
): (TerminalDriver & TerminalTypeCapability) | undefined {
	const driver = get(driverId);
	if (!driver || !hasTypeCapability(driver)) return undefined;
	return driver;
}

/**
 * Resolve the liveness provider for a recorded driver id. Returns the
 * registered driver only when it implements the liveness capability;
 * undefined for an unknown id or a spawn-only driver. Keyed strictly
 * by id so a recorded handle is probed through its own driver, never
 * whichever terminal the reader happens to be in.
 */
export function getLivenessProvider(
	driverId: string,
): (TerminalDriver & TerminalLivenessCapability) | undefined {
	const driver = get(driverId);
	if (!driver || !hasLivenessCapability(driver)) return undefined;
	return driver;
}

/**
 * The terminal surface the current pi process runs in, as a probeable
 * handle: the innermost terminal of the chain the session sits in that
 * can name its surface. Undefined when the session sits in none.
 *
 * Runs when every session starts, so it reads environment variables
 * and, on Linux, the process ancestry under `/proc`, which is a few
 * file reads and catches a terminal's variables inherited from
 * somewhere the session is not. Nothing is run.
 */
export function identifyCurrentTerminal(): TerminalSessionHandle | undefined {
	const drivers = list();
	const ancestry = currentPlatform() === "linux" ? linuxAncestry() : undefined;
	for (const sighting of sightChain(drivers, process.env, ancestry)) {
		if (sighting.handle) return sighting.handle;
	}
	// A driver that predates sightings may still know its surface.
	for (const driver of drivers) {
		if (driver.sight || !hasLivenessCapability(driver)) continue;
		const handle = driver.identifyCurrent();
		if (handle) return handle;
	}
	return undefined;
}

/**
 * Resolve the driver to use for a spawn. Preferred wins when it is
 * available; otherwise the terminal the plan would open through.
 */
export async function resolveDriver(
	preferred?: string,
): Promise<TerminalDriver | undefined> {
	if (preferred) {
		const driver = get(preferred);
		if (driver && (await driver.available())) return driver;
	}
	try {
		const { plan } = await openTerminal({}, { dryRun: true });
		return get(plan.terminal) ?? get("fallback");
	} catch {
		// No plan can be made: fall back to the old first-available rule.
		for (const driver of list()) {
			if (await driver.available()) return driver;
		}
		return undefined;
	}
}

/**
 * Convenience: resolve a driver and dispatch a request in
 * one call. Throws when no driver is available.
 */
export async function spawnTerminal(
	request: TerminalRequest,
	preferred?: string,
): Promise<TerminalDriver> {
	return (await spawnTerminalSurface(request, preferred)).driver;
}

/**
 * Spawn a surface and return both the driver and the handle it
 * named, for a caller that means to type into what it just made.
 * The handle is undefined when the driver cannot say what it
 * created.
 */
export async function spawnTerminalSurface(
	request: TerminalRequest,
	preferred?: string,
): Promise<{
	driver: TerminalDriver;
	handle: TerminalSessionHandle | undefined;
}> {
	if (list().length === 0) {
		throw new Error(
			"No terminal driver available. Register one or seed the built-ins with `registerBuiltinTerminalDrivers`.",
		);
	}
	const opened = await openTerminal(request, {
		...(preferred ? { call: { driver: preferred } } : {}),
	});
	const driver =
		get(opened.plan.terminal) ??
		get("fallback") ??
		(list()[0] as TerminalDriver);
	return { driver, handle: opened.handle };
}
