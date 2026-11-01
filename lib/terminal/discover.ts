/**
 * What terminals there are, and which ones the session sits in.
 *
 * Discovery is one pure function over what it is handed: the
 * environment, the platform, the registered drivers, the launchers,
 * where binaries resolve, and, when it was read, the process ancestry.
 * It never contacts a terminal; whether a control channel answers is
 * the business of whoever first tries it.
 *
 * The result is a landscape:
 *
 * - the chain of terminals the session sits in, innermost first;
 * - each registered driver, with the absolute path of its binary when
 *   it resolves;
 * - each launcher that applies on the platform and resolves.
 *
 * A terminal whose binary does not resolve is in the landscape only so
 * a refusal can say it was looked for; nothing offers it.
 */

import { locateBinary } from "../core/internal/terminal/binaries.ts";
import {
	appInstalled,
	type LauncherForm,
	type LauncherSpec,
	launcherLayouts,
	launcherOn,
} from "../core/internal/terminal/launchers.ts";
import type {
	HeldWindow,
	TerminalDriver,
	TerminalLayout,
	TerminalPlatform,
	TerminalSighting,
} from "./types.ts";

/** A registered driver and where its binary is, if anywhere. */
export interface DriverReach {
	readonly driver: TerminalDriver;
	/** The absolute binary path, absent when it did not resolve. */
	readonly binary?: string;
	/** Whether the driver runs nothing, and so needs no binary. */
	readonly needsNoBinary: boolean;
}

/** A launcher as it applies here, with its resolved binary. */
export interface LauncherReach {
	readonly id: string;
	readonly form: LauncherForm & { readonly binary: string };
	/** The absolute binary path. */
	readonly binary: string;
	/** The layouts it can open. */
	readonly layouts: readonly TerminalLayout[];
}

/** Everything discovery found. */
export interface TerminalLandscape {
	readonly platform: TerminalPlatform;
	/** The terminals the session sits in, innermost first. */
	readonly chain: readonly TerminalSighting[];
	readonly drivers: readonly DriverReach[];
	/** Launchers that apply on this platform and resolve, in trying order. */
	readonly launchers: readonly LauncherReach[];
	/** Launchers that apply but did not resolve, for refusals to name. */
	readonly missingLaunchers: readonly string[];
}

/** What discovery is handed. */
export interface DiscoveryInputs {
	readonly platform: TerminalPlatform;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly drivers: readonly TerminalDriver[];
	readonly launchers: readonly LauncherSpec[];
	/**
	 * The programs above this process, normalised, nearest first, when
	 * they were read. Absent, the environment's word stands alone.
	 */
	readonly ancestry?: readonly string[];
	/** Where a binary resolves, by id and name. */
	readonly locate?: (id: string, name: string) => string | undefined;
	/** Whether a macOS application bundle is installed. */
	readonly appInstalled?: (app: string) => boolean;
	/**
	 * The drivers written before discovery, which can neither sight their
	 * terminal nor name a binary, whose own `available()` said yes. They
	 * join the chain after every terminal discovery saw, so a driver a
	 * package registered by hand is still used, as it was before.
	 */
	readonly selfReported?: ReadonlySet<string>;
	/**
	 * The window the session's holder says it is shown in, when it runs
	 * held. Its environment and ancestry name no terminal then, so this
	 * is the only word on which one it sits in.
	 */
	readonly heldIn?: HeldWindow;
}

/**
 * Whether a driver predates discovery: it cannot sight its terminal,
 * names no binary and cannot launch, so only its own `available()`
 * says whether it can be used. The built-in fallback is not one; it is
 * the printed tier.
 */
export function isSelfReportingDriver(driver: TerminalDriver): boolean {
	return (
		driver.id !== "fallback" &&
		driver.sight === undefined &&
		driver.binary === undefined &&
		typeof (driver as { launch?: unknown }).launch !== "function"
	);
}

/** Find what terminals there are and where the session sits. */
export function discoverTerminals(inputs: DiscoveryInputs): TerminalLandscape {
	const locate =
		inputs.locate ??
		((id: string, name: string) => locateBinary(id, name, inputs.env.PATH));
	const drivers = inputs.drivers.map((driver): DriverReach => {
		const binary = driver.binary ? locate(driver.id, driver.binary) : undefined;
		return {
			driver,
			needsNoBinary: driver.binary === undefined,
			...(binary ? { binary } : {}),
		};
	});
	const launchers: LauncherReach[] = [];
	const missingLaunchers: string[] = [];
	for (const spec of orderedLaunchers(inputs)) {
		const form = launcherOn(spec, inputs.platform);
		if (!form) continue;
		const binary = locate(spec.id, form.binary);
		const installed =
			form.app === undefined ||
			(inputs.appInstalled ?? ((app: string) => appInstalled(app)))(form.app);
		if (!binary || !installed) {
			missingLaunchers.push(spec.id);
			continue;
		}
		launchers.push({
			id: spec.id,
			form,
			binary,
			layouts: launcherLayouts(form),
		});
	}
	const sighted = sightChain(inputs.drivers, inputs.env, inputs.ancestry);
	return {
		platform: inputs.platform,
		chain: [
			...withHolder(inputs.drivers, inputs.heldIn, sighted),
			...inputs.drivers
				.filter(
					(driver) =>
						isSelfReportingDriver(driver) &&
						inputs.selfReported?.has(driver.id),
				)
				.map(
					(driver): TerminalSighting => ({
						driverId: driver.id,
						reachable: true,
						source: "driver",
					}),
				),
		],
		drivers,
		launchers,
		missingLaunchers,
	};
}

/**
 * The sightings with the terminal the session's holder shows it in.
 * Its own reachable sighting of that terminal wins; one it can't reach,
 * as when the holder was started from a kitty that the ancestry names
 * with no variables to reach it by, gives way to the holder's window
 * in its place.
 */
function withHolder(
	drivers: readonly TerminalDriver[],
	heldIn: HeldWindow | undefined,
	sighted: readonly TerminalSighting[],
): TerminalSighting[] {
	if (!heldIn) return [...sighted];
	const own = sighted.findIndex((one) => one.driverId === heldIn.terminal);
	if (own >= 0 && sighted[own]?.reachable) return [...sighted];
	const driver = drivers.find((one) => one.id === heldIn.terminal);
	const seen = driver?.sightWindow?.(heldIn);
	if (!seen) return [...sighted];
	if (own < 0) return [...sighted, seen];
	return sighted.map((one, at) => (at === own ? seen : one));
}

/**
 * The launchers in trying order: the one `$TERMINAL` names first, when
 * it names one, since that is the person saying which they use.
 */
function orderedLaunchers(inputs: DiscoveryInputs): LauncherSpec[] {
	const named = inputs.env.TERMINAL?.trim();
	if (!named) return [...inputs.launchers];
	const base = named.split("/").pop() ?? named;
	const match = inputs.launchers.find(
		(spec) => spec.id === base || spec.binary === base,
	);
	if (match)
		return [match, ...inputs.launchers.filter((spec) => spec !== match)];
	return [...inputs.launchers];
}

/**
 * The terminals the session sits in, innermost first.
 *
 * Each driver reads its own variables. When the ancestry was read, it
 * confirms and orders them: a terminal whose variables are set but
 * whose program is nowhere above the session inherited them from
 * somewhere else and is dropped, and a terminal above the session that
 * set nothing is added as one that is there but cannot be reached.
 * Without the ancestry, multiplexers are taken to sit inside emulators,
 * which is the only way round they nest.
 */
export function sightChain(
	drivers: readonly TerminalDriver[],
	env: Readonly<Record<string, string | undefined>>,
	ancestry?: readonly string[],
): TerminalSighting[] {
	const sighted: {
		sighting: TerminalSighting;
		driver: TerminalDriver;
		depth: number;
	}[] = [];
	// A multiplexer's server leaves the terminal that started it, so a
	// session inside tmux or zellij has its server, not the emulator
	// showing it, as an ancestor. An emulator's variables seen beyond a
	// multiplexer are its word alone, and are taken as the outer terminal.
	const beyondMultiplexer =
		ancestry !== undefined &&
		drivers.some(
			(driver) =>
				driver.kind === "multiplexer" &&
				depthOf(driver, ancestry) !== undefined,
		);
	drivers.forEach((driver, order) => {
		const fromEnv = driver.sight?.(env);
		const depth = ancestry ? depthOf(driver, ancestry) : undefined;
		if (fromEnv) {
			const unconfirmed =
				ancestry !== undefined &&
				Boolean(driver.programs?.length) &&
				depth === undefined;
			const trusted = beyondMultiplexer && driver.kind !== "multiplexer";
			if (unconfirmed && !trusted) return;
			sighted.push({
				sighting: fromEnv,
				driver,
				depth:
					depth ??
					(unconfirmed
						? (ancestry?.length ?? 0) + order
						: fallbackDepth(driver, order)),
			});
			return;
		}
		if (depth !== undefined) {
			sighted.push({
				sighting: { driverId: driver.id, reachable: false, source: "ancestry" },
				driver,
				depth,
			});
		}
	});
	return sighted
		.sort((a, b) => a.depth - b.depth)
		.map((entry) => entry.sighting);
}

/** Where a driver's program first appears in the ancestry, nearest first. */
function depthOf(
	driver: TerminalDriver,
	ancestry: readonly string[],
): number | undefined {
	if (!driver.programs?.length) return undefined;
	const index = ancestry.findIndex((name) => driver.programs?.includes(name));
	return index === -1 ? undefined : index;
}

/** Without ancestry, multiplexers first, then registration order. */
function fallbackDepth(driver: TerminalDriver, order: number): number {
	const MULTIPLEXER_BAND = 0;
	const EMULATOR_BAND = 1_000;
	return (
		(driver.kind === "multiplexer" ? MULTIPLEXER_BAND : EMULATOR_BAND) + order
	);
}
