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
 * record keeps as `app_id`. With no output on, as with the lid shut, no
 * workspace has one, and none is in sight.
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
}

/**
 * Each parked hold with a window, paired with the pi session mycelium
 * lists it under, from `mycelium held` and `mycelium sessions`'s rows.
 * A hold no pi session names isn't a parked pi, and is left out.
 */
export function parkedWindowsOf(
	holds: readonly unknown[],
	sessions: readonly unknown[],
): ParkedWindows[] {
	return holds.flatMap((hold): ParkedWindows[] => {
		if (!isRecord(hold) || hold.parked !== true) return [];
		const windows = heldWindowsOf(hold) ?? [];
		if (windows.length === 0) return [];
		const row = sessions.find((one) => isRecord(one) && one.held === hold.id);
		if (!isRecord(row) || !isRecord(row.presence)) return [];
		const session = text(row.presence.session);
		if (session === "") return [];
		return [
			{ held: text(hold.id), session, address: text(row.address), windows },
		];
	});
}
