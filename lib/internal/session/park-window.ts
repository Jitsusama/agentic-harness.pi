/**
 * Whether a parking session's window may close, from what its holder
 * and niri say.
 *
 * Joel, 14 November: "should sessions put to sleep even have windows?
 * ... the cleanest method that things take minimal focus and energy if
 * they are not serving a purpose." A parked pi's holder outlives its
 * window, so the window can close and Agents opens it again in its place.
 * But never one Joel is using or looking at: a window focused, or on a
 * workspace shown on any output, keeps its session awake instead, and
 * says why. One that can't be placed for certain (no class of its own,
 * one niri doesn't show, a terminal this can't close) is left open as
 * parking always left it.
 *
 * A window is matched to niri's by its OS window's class, which a held
 * pi's kitty window is opened with (`pi-session.<n>`) and its holder's
 * record keeps as `app_id`.
 *
 * A screen that's off doesn't make every workspace fair game: Joel comes
 * back to what each output last showed (OSPHT4 [4e28d429]). With no
 * output on, as with the lid shut, niri names no workspace shown, so the
 * window he focused last counts as in sight, and so does its workspace
 * and every workspace remembered as shown from a read while the screen
 * was on. Off, with neither, nothing can be closed.
 */

import { isRecord } from "../record.ts";

/** A window a holder's record says shows its session. */
export interface HeldWindow {
	/** The terminal it is in: only kitty's can be closed from here. */
	readonly terminal: string;
	/** Its id within that terminal. */
	readonly id: string;
	/** The address of the terminal's remote control. */
	readonly within: string;
	/** Its OS window's class, as niri shows it, or "" when it has none. */
	readonly appId: string;
}

/** One of niri's windows, as far as this reads it. */
export interface ScreenWindow {
	readonly id: number;
	readonly appId: string;
	readonly workspace: number | undefined;
	readonly focused: boolean;
	/** When it last had the focus, in seconds on niri's clock. */
	readonly focusedAt?: number;
}

/** One of niri's workspaces, as far as this reads it. */
export interface ScreenWorkspace {
	readonly id: number;
	/** Shown on its output, if it has one. */
	readonly active: boolean;
	readonly focused: boolean;
	/** The output it is on, or null with no output on. */
	readonly output: string | null;
}

/** What niri shows. */
export interface Screen {
	readonly windows: readonly ScreenWindow[];
	readonly workspaces: readonly ScreenWorkspace[];
	/**
	 * The workspaces shown at the last read while the screen was on, which
	 * count as in sight while it's off.
	 */
	readonly remembered?: readonly number[];
}

/** Whether no output is on, so niri shows no workspace at all. */
export function screenOff(screen: Screen): boolean {
	return (
		screen.workspaces.length > 0 &&
		screen.workspaces.every((one) => one.output === null)
	);
}

/**
 * The workspaces shown on an output or focused, to remember for while
 * the screen is off; nothing while it's off already.
 */
export function shownNow(screen: Screen): number[] | undefined {
	if (screenOff(screen)) return undefined;
	return screen.workspaces
		.filter((one) => one.focused || (one.active && one.output !== null))
		.map((one) => one.id);
}

/** The window niri says had the focus last, if it says of any. */
function focusedLast(screen: Screen): ScreenWindow | undefined {
	let last: ScreenWindow | undefined;
	for (const one of screen.windows) {
		if (one.focusedAt === undefined) continue;
		if (last?.focusedAt === undefined || one.focusedAt > last.focusedAt) {
			last = one;
		}
	}
	return last;
}

/** Where a window stands while the screen is off. */
function placeWhileOff(niri: ScreenWindow, screen: Screen): One {
	const last = focusedLast(screen);
	const remembered = screen.remembered ?? [];
	if (last === undefined && remembered.length === 0) {
		return {
			kind: "leave",
			why: "the screen is off, and niri can't say what it last showed",
		};
	}
	if (last?.id === niri.id) {
		return {
			kind: "in-sight",
			why: "its window was focused last, as the screen went off",
		};
	}
	if (
		niri.workspace !== undefined &&
		(niri.workspace === last?.workspace || remembered.includes(niri.workspace))
	) {
		return {
			kind: "in-sight",
			why: "its window is on a workspace shown as the screen went off",
		};
	}
	return { kind: "close" };
}

/**
 * What becomes of a parking session's windows: they close; one is in
 * sight, so it doesn't park; one can't be placed, so they stay open; or
 * it has none.
 */
export type WindowVerdict =
	| { readonly kind: "close"; readonly windows: readonly HeldWindow[] }
	| { readonly kind: "in-sight"; readonly why: string }
	| { readonly kind: "leave"; readonly why: string }
	| { readonly kind: "none" };

/** The one terminal whose windows this can close. */
export const CLOSABLE_TERMINAL = "kitty";

type One =
	| { readonly kind: "close" }
	| { readonly kind: "in-sight" | "leave"; readonly why: string };

function placeOf(window: HeldWindow, screen: Screen): One {
	if (window.terminal !== CLOSABLE_TERMINAL) {
		return {
			kind: "leave",
			why: `its window is in ${window.terminal}, which can't be closed from here`,
		};
	}
	if (window.appId === "") {
		return { kind: "leave", why: "its window has no class of its own" };
	}
	const shown = screen.windows.filter((one) => one.appId === window.appId);
	if (shown.length !== 1) {
		return {
			kind: "leave",
			why:
				shown.length === 0
					? `niri shows no window of class ${window.appId}`
					: `niri shows ${shown.length} windows of class ${window.appId}`,
		};
	}
	const [niri] = shown;
	if (niri?.focused) return { kind: "in-sight", why: "its window is focused" };
	const workspace = screen.workspaces.find((one) => one.id === niri?.workspace);
	if (workspace === undefined) {
		return {
			kind: "leave",
			why: `niri doesn't say which workspace window ${niri?.id} is on`,
		};
	}
	if (niri !== undefined && screenOff(screen)) {
		return placeWhileOff(niri, screen);
	}
	if (workspace.focused || (workspace.active && workspace.output !== null)) {
		return { kind: "in-sight", why: "its window is on a workspace in sight" };
	}
	return { kind: "close" };
}

/**
 * What becomes of `windows` as their session parks. Any in sight keeps
 * it awake; otherwise any that can't be placed leaves them all open.
 */
export function windowVerdict(
	windows: readonly HeldWindow[],
	screen: Screen,
): WindowVerdict {
	if (windows.length === 0) return { kind: "none" };
	const each = windows.map((window) => placeOf(window, screen));
	for (const kind of ["in-sight", "leave"] as const) {
		const found = each.find((one) => one.kind === kind);
		if (found !== undefined && "why" in found) return { kind, why: found.why };
	}
	return { kind: "close", windows };
}

function text(value: unknown): string {
	if (typeof value === "string") return value;
	return typeof value === "number" ? String(value) : "";
}

/** When a window last had the focus, from niri's `focus_timestamp`. */
function focusedAtOf(stamp: unknown): { focusedAt?: number } {
	if (!isRecord(stamp) || typeof stamp.secs !== "number") return {};
	const nanos = typeof stamp.nanos === "number" ? stamp.nanos : 0;
	return { focusedAt: stamp.secs + nanos / 1e9 };
}

/**
 * What niri shows, from its replies to `windows` and `workspaces`, as
 * `niri msg -j` prints them. A reply that isn't a list reads as nothing.
 */
export function screenOf(windows: unknown, workspaces: unknown): Screen {
	const list = (reply: unknown) =>
		Array.isArray(reply) ? reply.filter(isRecord) : [];
	return {
		windows: list(windows).flatMap((one) =>
			typeof one.id === "number"
				? [
						{
							id: one.id,
							appId: text(one.app_id),
							workspace:
								typeof one.workspace_id === "number"
									? one.workspace_id
									: undefined,
							focused: one.is_focused === true,
							...focusedAtOf(one.focus_timestamp),
						},
					]
				: [],
		),
		workspaces: list(workspaces).flatMap((one) =>
			typeof one.id === "number"
				? [
						{
							id: one.id,
							active: one.is_active === true,
							focused: one.is_focused === true,
							output: typeof one.output === "string" ? one.output : null,
						},
					]
				: [],
		),
	};
}

/**
 * The windows a holder's record names (its `windows`), or nothing for a
 * record that names none or isn't one.
 */
export function heldWindowsOf(record: unknown): HeldWindow[] | undefined {
	if (!isRecord(record) || !Array.isArray(record.windows)) return undefined;
	return record.windows.filter(isRecord).map((one) => ({
		terminal: text(one.terminal),
		id: text(one.id),
		within: text(one.within),
		appId: text(one.app_id),
	}));
}

/**
 * Whether kitty, by its `@ ls` reply, shows `window` in an OS window of
 * its class. A holder's record keeps the id kitty gave the window, which
 * a restarted kitty gives out again to another, so the id alone could
 * close a window that isn't this session's.
 */
export function kittyShows(ls: unknown, window: HeldWindow): boolean {
	if (!Array.isArray(ls)) return false;
	return ls.some(
		(os) =>
			isRecord(os) &&
			os.wm_class === window.appId &&
			Array.isArray(os.tabs) &&
			os.tabs.some(
				(tab) =>
					isRecord(tab) &&
					Array.isArray(tab.windows) &&
					tab.windows.some(
						(one) => isRecord(one) && text(one.id) === window.id,
					),
			),
	);
}

/** A parked pi's hold and the windows it still keeps open. */
export interface ParkedWindows {
	readonly held: string;
	readonly session: string;
	readonly address: string;
	readonly windows: readonly HeldWindow[];
	/** Parked, rather than running: listed only when running ones are asked. */
	readonly parked: boolean;
}

/**
 * Each parked hold with a window, paired with the pi session mycelium
 * lists it under, from `mycelium held` and `mycelium sessions`'s rows;
 * with `running`, each running one too, to judge as if it parked now.
 * A hold no pi session names isn't a pi, and is left out.
 */
export function parkedWindowsOf(
	holds: readonly unknown[],
	sessions: readonly unknown[],
	running = false,
): ParkedWindows[] {
	return holds.flatMap((hold): ParkedWindows[] => {
		if (!isRecord(hold)) return [];
		const parked = hold.parked === true;
		if (!parked && !running) return [];
		const windows = heldWindowsOf(hold) ?? [];
		if (windows.length === 0) return [];
		const row = sessions.find((one) => isRecord(one) && one.held === hold.id);
		if (!isRecord(row) || !isRecord(row.presence)) return [];
		const session = text(row.presence.session);
		if (session === "") return [];
		return [
			{
				held: text(hold.id),
				session,
				address: text(row.address),
				windows,
				parked,
			},
		];
	});
}
