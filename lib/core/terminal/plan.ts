/**
 * Deciding how a new shell gets opened.
 *
 * A pure function from what discovery found and what the person chose
 * to one plan: which terminal, through which tier, in which layout, and
 * what was given up on the way. Three tiers, best first:
 *
 * - **attached**: a terminal the session sits in, through its own
 *   control channel, so the new surface is named, typed into and
 *   probed;
 * - **launched**: a new terminal process. Deep when the driver can
 *   start one under its control, so the window it opens is typed into
 *   and probed like an attached one; blind when it can only be handed
 *   a command;
 * - **printed**: the lines written out for the person to run.
 *
 * A layout the call asked for is honoured or refused. A layout that
 * came from a setting gives way to the nearest one that can be had, and
 * the plan says so. A tab with no window open to hold it is opened in a
 * new window, which is still a tab, and the plan says that too.
 */

import type {
	DriverReach,
	LauncherReach,
	TerminalLandscape,
} from "./discover.ts";
import type {
	Chosen,
	ResolvedTerminalChoice,
	TerminalLayer,
} from "./settings.ts";
import {
	rendersLayout,
	type TerminalDriver,
	type TerminalLaunchCapability,
	type TerminalLayout,
	type TerminalSessionHandle,
	type TerminalSighting,
} from "./types.ts";

/** How the new shell is reached. */
export type TerminalTier = "attached" | "launched" | "printed";

/** What the new surface can be made to do once it is open. */
export type TerminalControl = "deep" | "blind" | "none";

/** One decision about how to open a shell. */
export interface TerminalPlan {
	/** The driver or launcher that opens it. */
	readonly terminal: string;
	readonly tier: TerminalTier;
	readonly control: TerminalControl;
	/** The layout that will be opened. */
	readonly layout: TerminalLayout;
	/** The layout that was asked for, and by which layer. */
	readonly asked: Chosen<TerminalLayout>;
	/** Which layer chose the terminal, or discovery when none did. */
	readonly terminalFrom: TerminalLayer | "discovery";
	/** The absolute binary the plan runs, when it runs one. */
	readonly binary?: string;
	/** The attached surface a tab or pane is placed beside. */
	readonly near?: TerminalSessionHandle;
	/** What the person should know: substitutions and the like. */
	readonly notes: readonly string[];
}

/** A plan, or why there can be none. */
export type TerminalPlanResult =
	| { readonly ok: true; readonly plan: TerminalPlan }
	| { readonly ok: false; readonly refusal: string };

/** What planning may be told to leave out, after a tier failed. */
export interface PlanningExclusions {
	/** Terminals not to attach to, because trying failed. */
	readonly attached?: readonly string[];
	/** Terminals not to launch deep, because trying failed. */
	readonly launched?: readonly string[];
	/** Launchers not to try, because trying failed. */
	readonly blind?: readonly string[];
}

/** The layouts a request may give way to, nearest first. */
const NEAREST: Readonly<Record<TerminalLayout, readonly TerminalLayout[]>> = {
	window: ["tab"],
	tab: ["window"],
	pane: ["tab", "window"],
};

/** Decide how to open a shell. */
export function planTerminal(
	landscape: TerminalLandscape,
	choice: ResolvedTerminalChoice,
	exclude: PlanningExclusions = {},
): TerminalPlanResult {
	const asked = choice.layout;
	const layouts =
		asked.from === "call"
			? [asked.value]
			: [asked.value, ...NEAREST[asked.value]];
	const refusals: string[] = [];
	if (choice.driver && !known(landscape, choice.driver.value)) {
		return { ok: false, refusal: unknownTerminal(landscape, choice.driver) };
	}
	if (choice.driver && !resolves(landscape, choice.driver.value)) {
		return { ok: false, refusal: unresolved(landscape, choice.driver) };
	}
	for (const layout of layouts) {
		const found = choice.driver
			? planNamed(landscape, choice, layout, exclude)
			: planDiscovered(landscape, choice, layout, exclude);
		if (typeof found !== "string") {
			const notes = [...found.notes];
			if (layout !== asked.value) {
				notes.unshift(
					`opened a ${layout} instead of the ${asked.value} ${describeLayer(asked.from)} asked for: ${refusals[0] ?? `no terminal in reach can open a ${asked.value}`}`,
				);
			}
			return { ok: true, plan: { ...found, asked, notes } };
		}
		refusals.push(found);
	}
	const anything =
		usableTerminals(landscape).length > 0 ||
		landscape.chain.some((each) => each.reachable);
	if (!choice.driver && !anything) {
		// No terminal at all can be reached or started, but the lines can
		// always be written out, which is the one thing that never fails.
		return {
			ok: true,
			plan: {
				terminal: "fallback",
				tier: "printed",
				control: "none",
				layout: asked.value,
				asked,
				terminalFrom: "discovery",
				notes: [
					`no terminal in reach can open a ${asked.value} (${refusals[0] ?? "none was found"}), so the command is printed for you to run`,
				],
			},
		};
	}
	return {
		ok: false,
		refusal: choice.driver
			? `${choice.driver.value} cannot open a ${asked.value}: ${refusals[0]}`
			: `no terminal here can open the ${asked.value} ${describeLayer(asked.from)} asked for: ${refusals[0]}`,
	};
}

type Draft = Omit<TerminalPlan, "asked">;

/** A plan through the terminal a layer named, or why it cannot be one. */
function planNamed(
	landscape: TerminalLandscape,
	choice: ResolvedTerminalChoice,
	layout: TerminalLayout,
	exclude: PlanningExclusions,
): Draft | string {
	const id = choice.driver?.value ?? "";
	const from = choice.driver?.from ?? "defaults";
	const reach = landscape.drivers.find((each) => each.driver.id === id);
	if (reach && !rendersLayout(reach.driver, layout)) {
		return `${id} cannot open a ${layout} (it opens ${renderedBy(reach.driver)})`;
	}
	const sighting = landscape.chain.find(
		(each) => each.driverId === id && each.reachable,
	);
	if (reach && sighting && !exclude.attached?.includes(id)) {
		return attached(reach, sighting, layout, from);
	}
	if (layout === "pane") {
		return `a pane splits a terminal the session is in, and this session is not in a ${id} it can reach`;
	}
	if (
		reach &&
		canLaunch(reach.driver) &&
		reach.binary &&
		!exclude.launched?.includes(id)
	) {
		return launchedDeep(reach, layout, from);
	}
	const launcher = landscape.launchers.find((each) => each.id === id);
	if (launcher && !exclude.blind?.includes(id)) {
		return launchedBlind(launcher, layout, from);
	}
	return reach?.driver.kind === "multiplexer"
		? `${id} opens inside a terminal the session is in, and this session is not in one it can reach`
		: `${id} is not running where this session can reach it, and cannot be launched here`;
}

/** A plan through whatever discovery found, or why there is none. */
function planDiscovered(
	landscape: TerminalLandscape,
	choice: ResolvedTerminalChoice,
	layout: TerminalLayout,
	exclude: PlanningExclusions,
): Draft | string {
	const reachable = landscape.chain
		.map((sighting) => ({
			sighting,
			reach: landscape.drivers.find(
				(each) => each.driver.id === sighting.driverId,
			),
		}))
		.filter(
			(entry): entry is { sighting: TerminalSighting; reach: DriverReach } =>
				entry.sighting.reachable &&
				entry.reach !== undefined &&
				(entry.reach.binary !== undefined || entry.reach.needsNoBinary) &&
				rendersLayout(entry.reach.driver, layout) &&
				!exclude.attached?.includes(entry.sighting.driverId),
		);
	const nesting = choice.nesting[layout];
	const pick = nesting.value === "outermost" ? reachable.at(-1) : reachable[0];
	if (pick) {
		const draft = attached(pick.reach, pick.sighting, layout, "discovery");
		const skipped = nesting.value === "innermost" ? [] : reachable.slice(0, -1);
		return skipped.length > 0 && nesting.from !== "built in"
			? {
					...draft,
					notes: [
						...draft.notes,
						`went to the outermost terminal, ${pick.sighting.driverId}, rather than ${skipped[0]?.sighting.driverId}, as ${describeLayer(nesting.from)} asks`,
					],
				}
			: draft;
	}
	if (layout === "pane") {
		return "a pane splits a terminal the session is in, and this session is in none it can reach";
	}
	// Launch the terminal the session already sits in, when it can be,
	// so the new window looks like the ones the person already has.
	const sitting = [...landscape.chain].reverse();
	const preferred = [
		...sitting
			.map((sighting) =>
				landscape.drivers.find((each) => each.driver.id === sighting.driverId),
			)
			.filter((each): each is DriverReach => each !== undefined),
		...landscape.drivers,
	];
	const deep = preferred.find(
		(each) =>
			each.binary !== undefined &&
			canLaunch(each.driver) &&
			!exclude.launched?.includes(each.driver.id),
	);
	if (deep) return launchedDeep(deep, layout, "discovery");
	const sittingIds = sitting.map((sighting) => sighting.driverId);
	const blind = [...landscape.launchers]
		.sort((a, b) => rank(sittingIds, a.id) - rank(sittingIds, b.id))
		.find((each) => !exclude.blind?.includes(each.id));
	if (blind) return launchedBlind(blind, layout, "discovery");
	return "no terminal program was found to launch";
}

function rank(ids: readonly string[], id: string): number {
	const index = ids.indexOf(id);
	return index === -1 ? ids.length : index;
}

function attached(
	reach: DriverReach,
	sighting: TerminalSighting,
	layout: TerminalLayout,
	from: TerminalLayer | "discovery",
): Draft {
	return {
		terminal: reach.driver.id,
		tier: "attached",
		control: "deep",
		layout,
		terminalFrom: from,
		...(reach.binary ? { binary: reach.binary } : {}),
		...(sighting.handle ? { near: sighting.handle } : {}),
		notes: [],
	};
}

function launchedDeep(
	reach: DriverReach,
	layout: TerminalLayout,
	from: TerminalLayer | "discovery",
): Draft {
	return {
		terminal: reach.driver.id,
		tier: "launched",
		control: "deep",
		layout,
		terminalFrom: from,
		...(reach.binary ? { binary: reach.binary } : {}),
		notes:
			layout === "tab"
				? [
						`the tab is in a new ${reach.driver.id} window, since no ${reach.driver.id} window the session can reach was open to hold it`,
					]
				: [],
	};
}

function launchedBlind(
	launcher: LauncherReach,
	layout: TerminalLayout,
	from: TerminalLayer | "discovery",
): Draft {
	const tab = layout === "tab" && launcher.layouts.includes("tab");
	return {
		terminal: launcher.id,
		tier: "launched",
		control: "blind",
		layout,
		terminalFrom: from,
		binary: launcher.binary,
		notes: [
			...(layout === "tab" && !tab
				? [
						`the tab is in a new ${launcher.id} window, since ${launcher.id} cannot add a tab from outside`,
					]
				: []),
			`${launcher.id} is launched without remote control, so the new window cannot be typed into or watched; the command runs through your login shell`,
		],
	};
}

function canLaunch(
	driver: TerminalDriver,
): driver is TerminalDriver & TerminalLaunchCapability {
	return (
		typeof (driver as Partial<TerminalLaunchCapability>).launch === "function"
	);
}

function known(landscape: TerminalLandscape, id: string): boolean {
	return (
		landscape.drivers.some((each) => each.driver.id === id) ||
		landscape.launchers.some((each) => each.id === id) ||
		landscape.missingLaunchers.includes(id)
	);
}

function resolves(landscape: TerminalLandscape, id: string): boolean {
	const reach = landscape.drivers.find((each) => each.driver.id === id);
	if (reach && (reach.binary !== undefined || reach.needsNoBinary)) return true;
	return landscape.launchers.some((each) => each.id === id);
}

/** Every terminal that can actually be used here, for refusals to list. */
export function usableTerminals(landscape: TerminalLandscape): string[] {
	const ids = new Set<string>();
	for (const reach of landscape.drivers) {
		if (reach.binary !== undefined && !reach.needsNoBinary)
			ids.add(reach.driver.id);
	}
	for (const launcher of landscape.launchers) ids.add(launcher.id);
	return [...ids];
}

function unknownTerminal(
	landscape: TerminalLandscape,
	named: Chosen<string>,
): string {
	return `${describeLayer(named.from)} names "${named.value}", which is no terminal this library knows; ${listUsable(landscape)}`;
}

function unresolved(
	landscape: TerminalLandscape,
	named: Chosen<string>,
): string {
	return `${describeLayer(named.from)} names ${named.value}, but its program was not found on PATH or at a configured terminal.drivers path; ${listUsable(landscape)}`;
}

function listUsable(landscape: TerminalLandscape): string {
	const usable = usableTerminals(landscape);
	return usable.length > 0
		? `the terminals usable here are ${usable.join(", ")}`
		: "no terminal program was found here at all";
}

function renderedBy(driver: TerminalDriver): string {
	const layouts = Object.keys(driver.layouts ?? {});
	return layouts.length > 0 ? layouts.join(" and ") : "nothing";
}

/** How a layer is named in prose. */
export function describeLayer(from: TerminalLayer | "discovery"): string {
	switch (from) {
		case "call":
			return "the call";
		case "quest":
			return "the quest's terminal setting";
		case "project":
			return "the project's terminal setting";
		case "defaults":
			return "terminal.defaults";
		case "built in":
			return "the built-in default";
		case "discovery":
			return "discovery";
	}
}
