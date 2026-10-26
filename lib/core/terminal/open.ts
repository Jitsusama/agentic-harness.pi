/**
 * Opening shells: discovery, settings and a plan, carried out.
 *
 * `openTerminal` opens one shell and `openTerminals` opens several
 * together, which matters when they are tabs with no window to hold
 * them: the first opens a new window and the rest join it as tabs.
 * Both can be asked for a dry run, which reports the plan and opens
 * nothing.
 *
 * A command always runs under the person's own startup files. Under
 * deep control a bare login shell is opened and the command typed into
 * it; on a blind launch it runs through `$SHELL -l -i -c`. When a tier
 * fails before anything opened, the next one down is tried, and the
 * answer says what happened.
 */

import {
	linuxAncestry,
	processAncestry,
} from "../internal/terminal/ancestry.ts";
import {
	forgetBinaries,
	setBinaryOverrides,
} from "../internal/terminal/binaries.ts";
import {
	launchEnvironment,
	loginShellArgv,
	shellQuote,
	typedLine,
} from "../internal/terminal/drivers/shared.ts";
import {
	BUILTIN_LAUNCHERS,
	fillTemplate,
	type LauncherSpec,
	startDetached,
} from "../internal/terminal/launchers.ts";
import { list } from "../internal/terminal/registry.ts";
import {
	discoverTerminals,
	isSelfReportingDriver,
	sightChain,
	type TerminalLandscape,
} from "./discover.ts";
import {
	describeLayer,
	type PlanningExclusions,
	planTerminal,
	type TerminalPlan,
} from "./plan.ts";
import {
	resolveTerminalChoice,
	type TerminalChoice,
	type TerminalPlace,
	type TerminalSettings,
} from "./settings.ts";
import type {
	TerminalDriver,
	TerminalLaunchCapability,
	TerminalLayout,
	TerminalPlatform,
	TerminalRequest,
	TerminalSessionHandle,
	TerminalTypeCapability,
} from "./types.ts";

/** A shell to open. The layout, when given, is the call's own choice. */
export interface OpenRequest extends Omit<TerminalRequest, "layout"> {
	readonly layout?: TerminalLayout;
}

/** What opening is done with. */
export interface OpenOptions {
	/** The person's `terminal` settings. */
	readonly settings?: TerminalSettings;
	/** The quest and project the request comes from. */
	readonly place?: Omit<TerminalPlace, "call">;
	/** The call's own choices beyond its layout: terminal and nesting. */
	readonly call?: Omit<TerminalChoice, "layout">;
	/** Plan only; open nothing. */
	readonly dryRun?: boolean;
	/** The session's environment. Defaults to this process's. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** The platform. Defaults to this one. */
	readonly platform?: TerminalPlatform;
	/** The drivers to choose among. Defaults to the registered ones. */
	readonly drivers?: readonly TerminalDriver[];
	/**
	 * The programs above this process, nearest first, or false to leave
	 * the ancestry unread. Defaults to reading it: at once on Linux,
	 * where it is a few file reads, and on macOS only when the
	 * environment names more than one terminal, since it costs a process
	 * there.
	 */
	readonly ancestry?: readonly string[] | false;
}

/** How a command reached its shell. */
export type OpenedHow = "typed" | "handed" | "printed" | "planned";

/** One shell opened, or planned. */
export interface OpenedTerminal {
	readonly plan: TerminalPlan;
	/** The new surface, when the terminal could name it. */
	readonly handle?: TerminalSessionHandle;
	readonly how: OpenedHow;
	/** What the person should know, the plan's notes included. */
	readonly notes: readonly string[];
}

/** One shell's outcome among several. */
export type OpenedOutcome =
	| ({ readonly ok: true } & OpenedTerminal)
	| { readonly ok: false; readonly error: string };

/** How many shells `openTerminals` opens at once. */
export const OPEN_CONCURRENCY = 4;

/** Open one shell. Throws with the reason when none can be opened. */
export async function openTerminal(
	request: OpenRequest,
	options: OpenOptions = {},
): Promise<OpenedTerminal> {
	const context = await prepare(options);
	return openWith(context, request, {});
}

/**
 * Open several shells with one plan. Tabs with no window to hold them
 * are gathered into one new window. Each shell's outcome is reported
 * on its own, so one that fails does not hide the rest.
 */
export async function openTerminals(
	requests: readonly OpenRequest[],
	options: OpenOptions & { readonly concurrency?: number } = {},
): Promise<OpenedOutcome[]> {
	const [first, ...rest] = requests;
	if (!first) return [];
	const context = await prepare(options);
	let leader: OpenedTerminal;
	try {
		leader = await openWith(context, first, {});
	} catch (error) {
		// The first failing says nothing about the others, each of which
		// is tried on its own.
		const others = await inBatches(rest, options.concurrency, (request) =>
			openWith(context, request, {}),
		);
		return [{ ok: false, error: messageOf(error) }, ...others];
	}
	const gather =
		leader.plan.tier === "launched" &&
		leader.plan.control === "deep" &&
		leader.plan.layout === "tab" &&
		leader.handle !== undefined;
	const followers = await inBatches(
		rest,
		gather ? 1 : options.concurrency,
		(request) =>
			gather && leader.handle
				? openBeside(context, leader, request)
				: openWith(context, request, {}),
	);
	return [{ ok: true, ...leader }, ...followers];
}

/** What every open in one call shares. */
interface Context {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly platform: TerminalPlatform;
	readonly drivers: readonly TerminalDriver[];
	readonly landscape: TerminalLandscape;
	readonly settings: TerminalSettings | undefined;
	readonly place: Omit<TerminalPlace, "call">;
	readonly call: Omit<TerminalChoice, "layout">;
	readonly dryRun: boolean;
	/** Whether the ancestry has been read into the landscape. */
	readonly ancestryRead: boolean;
}

async function prepare(options: OpenOptions): Promise<Context> {
	const env = options.env ?? process.env;
	const platform = options.platform ?? currentPlatform();
	const drivers = options.drivers ?? list();
	setBinaryOverrides(binaryPaths(options.settings));
	const ancestry =
		options.ancestry === false
			? undefined
			: (options.ancestry ??
				(platform === "linux" ? linuxAncestry() : undefined));
	const selfReported = new Set<string>();
	for (const driver of drivers) {
		if (isSelfReportingDriver(driver) && (await driver.available())) {
			selfReported.add(driver.id);
		}
	}
	const landscape = discoverTerminals({
		platform,
		env,
		drivers,
		launchers: mergedLaunchers(options.settings),
		selfReported,
		...(ancestry ? { ancestry } : {}),
	});
	return {
		env,
		platform,
		drivers,
		landscape,
		settings: options.settings,
		place: options.place ?? {},
		call: options.call ?? {},
		dryRun: options.dryRun === true,
		ancestryRead: ancestry !== undefined || options.ancestry === false,
	};
}

async function openWith(
	context: Context,
	request: OpenRequest,
	exclude: PlanningExclusions,
): Promise<OpenedTerminal> {
	const ctx = await withAncestry(context);
	const choice = resolveTerminalChoice(ctx.settings, {
		...ctx.place,
		call: {
			...ctx.call,
			...(request.layout ? { layout: request.layout } : {}),
		},
	});
	const planned = planTerminal(ctx.landscape, choice, exclude);
	if (!planned.ok) throw new Error(planned.refusal);
	const plan = planned.plan;
	if (ctx.dryRun) return { plan, how: "planned", notes: plan.notes };
	try {
		return await carryOut(ctx, plan, request);
	} catch (error) {
		if (plan.tier === "printed") throw error;
		forgetBinaries();
		const next: PlanningExclusions = {
			attached: [
				...(exclude.attached ?? []),
				...(plan.tier === "attached" ? [plan.terminal] : []),
			],
			launched: [
				...(exclude.launched ?? []),
				...(plan.tier === "launched" && plan.control === "deep"
					? [plan.terminal]
					: []),
			],
			blind: [
				...(exclude.blind ?? []),
				...(plan.control === "blind" ? [plan.terminal] : []),
			],
		};
		let retried: OpenedTerminal;
		try {
			retried = await openWith(ctx, request, next);
		} catch (later) {
			throw new Error(
				`${plan.terminal} (${plan.tier}) failed: ${messageOf(error)}; then ${messageOf(later)}`,
			);
		}
		return {
			...retried,
			notes: [
				`${plan.terminal} (${plan.tier}) failed, so ${retried.plan.terminal} (${retried.plan.tier}) was used: ${messageOf(error)}`,
				...retried.notes,
			],
		};
	}
}

/** Open a tab in the window a launched leader opened. */
async function openBeside(
	context: Context,
	leader: OpenedTerminal,
	request: OpenRequest,
): Promise<OpenedTerminal> {
	const driver = context.drivers.find(
		(each) => each.id === leader.plan.terminal,
	);
	if (!driver || !leader.handle) return openWith(context, request, {});
	const plan: TerminalPlan = {
		...leader.plan,
		tier: "attached",
		notes: [
			`opened as a tab in the ${leader.plan.terminal} window the first of these opened`,
		],
	};
	return spawnAttached(driver, plan, {
		...request,
		layout: "tab",
		near: leader.handle,
	});
}

/**
 * Open a surface through a driver attached to its terminal, typing the
 * command in when the driver can type, handing it over when it cannot.
 */
async function spawnAttached(
	driver: TerminalDriver,
	plan: TerminalPlan,
	request: TerminalRequest,
): Promise<OpenedTerminal> {
	if (request.command !== undefined && !canType(driver)) {
		const handle = await driver.spawn(request);
		return {
			plan,
			...(handle ? { handle } : {}),
			how: "handed",
			notes: [
				...plan.notes,
				`${driver.id} cannot type into a shell, so the command was handed over and runs without your startup files`,
			],
		};
	}
	const handle = await driver.spawn(withoutCommand(request));
	return typeInto(driver, plan, handle, request);
}

async function carryOut(
	context: Context,
	plan: TerminalPlan,
	request: OpenRequest,
): Promise<OpenedTerminal> {
	const driver = context.drivers.find((each) => each.id === plan.terminal);
	if (plan.tier === "printed") {
		// The lines go back in the answer, where the person reads them,
		// rather than to a stderr the session's own display owns.
		return {
			plan,
			how: "printed",
			notes: [...plan.notes, `run: ${printedLine(request)}`],
		};
	}
	if (plan.tier === "attached" && driver) {
		const advice = await adviceFor(driver, {
			...request,
			layout: plan.layout,
			...(plan.near ? { near: plan.near } : {}),
		});
		const opened = await spawnAttached(driver, plan, {
			...request,
			layout: plan.layout,
			...(plan.near && plan.layout !== "window" ? { near: plan.near } : {}),
		});
		return advice ? { ...opened, notes: [...opened.notes, advice] } : opened;
	}
	if (
		plan.tier === "launched" &&
		plan.control === "deep" &&
		driver &&
		canLaunch(driver) &&
		plan.binary
	) {
		const handle = await driver.launch(
			withoutCommand({ ...request, layout: plan.layout }),
			{
				binary: plan.binary,
				platform: context.platform,
				env: launchEnvironment(context.env),
			},
		);
		return typeInto(driver, plan, handle, request);
	}
	return launchBlind(context, plan, request);
}

/**
 * Type the command into the bare shell a driver just opened. A driver
 * that opened a shell but could not name it leaves nothing to type
 * into, and opening a second one would put two shells where one was
 * asked for, so the answer says so instead.
 */
async function typeInto(
	driver: TerminalDriver,
	plan: TerminalPlan,
	handle: TerminalSessionHandle | undefined,
	request: OpenRequest,
): Promise<OpenedTerminal> {
	const base = { plan, ...(handle ? { handle } : {}) };
	if (request.command === undefined)
		return { ...base, how: "typed", notes: plan.notes };
	if (!handle || !canType(driver)) {
		return {
			...base,
			how: "handed",
			notes: [
				...plan.notes,
				`${driver.id} opened a shell but did not say which, so nothing was typed into it; run this there: ${request.command}`,
			],
		};
	}
	await driver.typeInto(handle, typedLine(request.command, request.env));
	return { ...base, how: "typed", notes: plan.notes };
}

async function launchBlind(
	context: Context,
	plan: TerminalPlan,
	request: OpenRequest,
): Promise<OpenedTerminal> {
	const launcher = context.landscape.launchers.find(
		(each) => each.id === plan.terminal,
	);
	if (!launcher) throw new Error(`${plan.terminal} has no launch form here`);
	const shell = context.env.SHELL ?? "/bin/sh";
	const argv =
		request.command === undefined
			? [shell, "-l"]
			: loginShellArgv(shell, request.command, {
					...(request.env ? { env: request.env } : {}),
					...(context.settings?.wrap ? { wrap: context.settings.wrap } : {}),
					...(request.cwd ? { cwd: request.cwd } : {}),
				});
	const template =
		plan.layout === "tab" && launcher.form.tab
			? launcher.form.tab
			: launcher.form.window;
	const args = template
		? fillTemplate(template, {
				...(request.cwd ? { cwd: request.cwd } : {}),
				...(request.title ? { title: request.title } : {}),
				argv,
			})
		: undefined;
	if (!args)
		throw new Error(
			`${launcher.id}'s launch form has nowhere to put the command`,
		);
	await startDetached(launcher.binary, args, {
		...(request.cwd ? { cwd: request.cwd } : {}),
		env: launchEnvironment(context.env),
	});
	return { plan, how: "handed", notes: plan.notes };
}

/**
 * On macOS, read the ancestry when the environment names more than one
 * terminal, since only the ancestry can say which sits inside which.
 */
async function withAncestry(context: Context): Promise<Context> {
	if (context.ancestryRead) return context;
	if (
		context.landscape.chain.filter((each) => each.source === "environment")
			.length < 2
	) {
		return context;
	}
	const ancestry = await processAncestry(context.platform);
	return {
		...context,
		ancestryRead: true,
		landscape: {
			...context.landscape,
			chain: [
				...sightChain(context.drivers, context.env, ancestry),
				...context.landscape.chain.filter((each) => each.source === "driver"),
			],
		},
	};
}

async function adviceFor(
	driver: TerminalDriver,
	request: TerminalRequest,
): Promise<string | undefined> {
	const advise = (
		driver as { advise?: (r: TerminalRequest) => Promise<string | undefined> }
	).advise;
	return typeof advise === "function"
		? advise.call(driver, request)
		: undefined;
}

function canType(
	driver: TerminalDriver,
): driver is TerminalDriver & TerminalTypeCapability {
	return (
		typeof (driver as Partial<TerminalTypeCapability>).typeInto === "function"
	);
}

function canLaunch(
	driver: TerminalDriver,
): driver is TerminalDriver & TerminalLaunchCapability {
	return (
		typeof (driver as Partial<TerminalLaunchCapability>).launch === "function"
	);
}

function withoutCommand<T extends { command?: string }>(
	request: T,
): Omit<T, "command"> {
	const { command: _command, ...rest } = request;
	return rest;
}

/** The built-in launchers with the configured ones laid over them by id. */
export function mergedLaunchers(
	settings: TerminalSettings | undefined,
): LauncherSpec[] {
	const configured = settings?.launchers ?? {};
	const merged: LauncherSpec[] = BUILTIN_LAUNCHERS.map((spec) => {
		const over = configured[spec.id];
		return over
			? ({
					...spec,
					...over,
					id: spec.id,
					binary: over.binary ?? spec.binary,
				} as LauncherSpec)
			: spec;
	});
	for (const [id, over] of Object.entries(configured)) {
		if (merged.some((spec) => spec.id === id)) continue;
		merged.push({ ...over, id, binary: over.binary ?? id } as LauncherSpec);
	}
	return merged;
}

function binaryPaths(
	settings: TerminalSettings | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [id, entry] of Object.entries(settings?.drivers ?? {})) {
		if (entry.path) out[id] = entry.path;
	}
	return out;
}

/** The platform this process runs on, as the library names it. */
export function currentPlatform(): TerminalPlatform {
	return process.platform === "darwin" ? "darwin" : "linux";
}

async function inBatches<T extends OpenedTerminal>(
	requests: readonly OpenRequest[],
	concurrency: number | undefined,
	open: (request: OpenRequest) => Promise<T>,
): Promise<OpenedOutcome[]> {
	const width = Math.max(1, concurrency ?? OPEN_CONCURRENCY);
	const out: OpenedOutcome[] = new Array(requests.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < requests.length) {
			const index = next++;
			const request = requests[index];
			if (!request) continue;
			try {
				out[index] = { ok: true, ...(await open(request)) };
			} catch (error) {
				out[index] = { ok: false, error: messageOf(error) };
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(width, requests.length) }, worker),
	);
	return out;
}

/** The line a person runs by hand to get what a request asked for. */
export function printedLine(request: OpenRequest): string {
	const command = request.command ?? "$SHELL -l";
	const line = typedLine(command, request.env).trimEnd();
	return request.cwd ? `(cd ${shellQuote(request.cwd)} && ${line})` : line;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One line saying what a plan used and which layer chose each part. */
export function describePlan(plan: TerminalPlan): string {
	const how =
		plan.tier === "launched"
			? `launched${plan.control === "blind" ? " blind" : ""}`
			: plan.tier;
	return `${plan.terminal}, ${how}, ${plan.layout} (terminal from ${describeLayer(plan.terminalFrom)}, layout from ${describeLayer(plan.asked.from)})`;
}
