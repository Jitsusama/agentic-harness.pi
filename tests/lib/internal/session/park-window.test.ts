/**
 * Whether a parking session's window may close: only one niri shows on
 * no workspace in sight, never the one focused.
 */

import { describe, expect, it } from "vitest";
import {
	type HeldWindow,
	heldWindowsOf,
	kittyShows,
	parkedWindowsOf,
	type Screen,
	screenOf,
	windowVerdict,
} from "../../../../lib/internal/session/park-window.ts";

const SOCKET = "unix:/run/user/1000/pi-sessions/kitty.sock";

function held(id: string, appId: string): HeldWindow {
	return { terminal: "kitty", id, within: SOCKET, appId };
}

/** Workspace 1 is shown and focused; 2 is shown on another output; 3 hides. */
function screen(
	windows: {
		id: number;
		appId: string;
		workspace: number;
		focused?: boolean;
	}[],
): Screen {
	return {
		windows: windows.map((one) => ({ focused: false, ...one })),
		workspaces: [
			{ id: 1, active: true, focused: true, output: "eDP-1" },
			{ id: 2, active: true, focused: false, output: "DP-1" },
			{ id: 3, active: false, focused: false, output: "eDP-1" },
		],
	};
}

describe("windowVerdict", () => {
	it("closes a window on a hidden workspace", () => {
		const window = held("33", "pi-session.1");
		expect(
			windowVerdict(
				[window],
				screen([{ id: 7, appId: "pi-session.1", workspace: 3 }]),
			),
		).toEqual({ kind: "close", windows: [window] });
	});

	it("refuses when its window is focused", () => {
		expect(
			windowVerdict(
				[held("33", "pi-session.1")],
				screen([{ id: 7, appId: "pi-session.1", workspace: 3, focused: true }]),
			),
		).toEqual({ kind: "in-sight", why: "its window is focused" });
	});

	it("refuses when its window is on the focused workspace", () => {
		expect(
			windowVerdict(
				[held("33", "pi-session.1")],
				screen([{ id: 7, appId: "pi-session.1", workspace: 1 }]),
			),
		).toEqual({
			kind: "in-sight",
			why: "its window is on a workspace in sight",
		});
	});

	it("refuses when its window is on another output's shown workspace", () => {
		expect(
			windowVerdict(
				[held("33", "pi-session.1")],
				screen([{ id: 7, appId: "pi-session.1", workspace: 2 }]),
			).kind,
		).toBe("in-sight");
	});

	it("counts no workspace in sight with no output on", () => {
		const window = held("33", "pi-session.1");
		const lidShut: Screen = {
			windows: [{ id: 7, appId: "pi-session.1", workspace: 1, focused: false }],
			workspaces: [{ id: 1, active: true, focused: false, output: null }],
		};
		expect(windowVerdict([window], lidShut)).toEqual({
			kind: "close",
			windows: [window],
		});
	});

	it("refuses when any of its windows is in sight", () => {
		expect(
			windowVerdict(
				[held("33", "pi-session.1"), held("34", "pi-session.2")],
				screen([
					{ id: 7, appId: "pi-session.1", workspace: 3 },
					{ id: 8, appId: "pi-session.2", workspace: 1 },
				]),
			).kind,
		).toBe("in-sight");
	});

	it("has nothing to close for a session with no window", () => {
		expect(windowVerdict([], screen([]))).toEqual({ kind: "none" });
	});

	it("leaves a window niri doesn't show open", () => {
		expect(windowVerdict([held("33", "pi-session.1")], screen([]))).toEqual({
			kind: "leave",
			why: "niri shows no window of class pi-session.1",
		});
	});

	it("leaves a window whose class two niri windows share open", () => {
		expect(
			windowVerdict(
				[held("33", "kitty")],
				screen([
					{ id: 7, appId: "kitty", workspace: 3 },
					{ id: 8, appId: "kitty", workspace: 3 },
				]),
			),
		).toEqual({
			kind: "leave",
			why: "niri shows 2 windows of class kitty",
		});
	});

	it("leaves a window with no class, or not kitty's, open", () => {
		expect(windowVerdict([held("33", "")], screen([])).kind).toBe("leave");
		expect(
			windowVerdict(
				[{ ...held("33", "pi-session.1"), terminal: "foot" }],
				screen([{ id: 7, appId: "pi-session.1", workspace: 3 }]),
			),
		).toEqual({
			kind: "leave",
			why: "its window is in foot, which can't be closed from here",
		});
	});

	it("leaves a window on a workspace niri doesn't list open", () => {
		expect(
			windowVerdict(
				[held("33", "pi-session.1")],
				screen([{ id: 7, appId: "pi-session.1", workspace: 9 }]),
			).kind,
		).toBe("leave");
	});
});

describe("screenOf", () => {
	it("reads niri's windows and workspaces as `niri msg -j` prints them", () => {
		expect(
			screenOf(
				[
					{
						id: 18,
						app_id: "pi-session.1",
						workspace_id: 3,
						is_focused: false,
					},
					{ id: 19, app_id: null, workspace_id: null, is_focused: true },
				],
				[
					{
						id: 3,
						is_active: false,
						is_focused: false,
						output: "eDP-1",
					},
				],
			),
		).toEqual({
			windows: [
				{ id: 18, appId: "pi-session.1", workspace: 3, focused: false },
				{ id: 19, appId: "", workspace: undefined, focused: true },
			],
			workspaces: [{ id: 3, active: false, focused: false, output: "eDP-1" }],
		});
	});

	it("reads nothing from replies that aren't lists", () => {
		expect(screenOf({ Err: "no" }, null)).toEqual({
			windows: [],
			workspaces: [],
		});
	});
});

describe("heldWindowsOf", () => {
	it("reads the windows a holder's record names", () => {
		expect(
			heldWindowsOf({
				id: "fe160b8e",
				windows: [
					{
						terminal: "kitty",
						id: "33",
						within: SOCKET,
						app_id: "pi-session.1",
					},
					{ terminal: "kitty", id: 34, within: SOCKET },
				],
			}),
		).toEqual([held("33", "pi-session.1"), held("34", "")]);
	});

	it("answers nothing for a record that names no windows", () => {
		expect(heldWindowsOf({ id: "x" })).toBeUndefined();
		expect(heldWindowsOf(undefined)).toBeUndefined();
	});
});

describe("kittyShows", () => {
	const ls = [
		{
			id: 1,
			wm_class: "pi-sessions-kept",
			tabs: [{ windows: [{ id: 1 }] }],
		},
		{
			id: 2,
			wm_class: "pi-session.1",
			tabs: [{ windows: [{ id: 33 }] }],
		},
	];

	it("holds a window kitty shows in an OS window of its class", () => {
		expect(kittyShows(ls, held("33", "pi-session.1"))).toBe(true);
	});

	it("refuses an id kitty gave another window, as after kitty restarts", () => {
		expect(kittyShows(ls, held("1", "pi-session.1"))).toBe(false);
		expect(kittyShows(ls, held("34", "pi-session.1"))).toBe(false);
	});

	it("refuses a reply that isn't kitty's list", () => {
		expect(kittyShows({ error: "no" }, held("33", "pi-session.1"))).toBe(false);
	});
});

describe("parkedWindowsOf", () => {
	it("pairs each parked hold with its pi session, skipping running ones", () => {
		const holds = [
			{
				id: "fe160b8e",
				parked: true,
				windows: [
					{
						terminal: "kitty",
						id: "33",
						within: SOCKET,
						app_id: "pi-session.1",
					},
				],
			},
			{ id: "309ddbc5", windows: [] },
			{ id: "0a0a0a0a", parked: true, windows: [] },
		];
		const sessions = [
			{ held: "fe160b8e", address: "VKCF3Z", presence: { session: "s-1" } },
			{ held: "309ddbc5", address: "AAAAAA", presence: { session: "s-2" } },
		];
		expect(parkedWindowsOf(holds, sessions)).toEqual([
			{
				held: "fe160b8e",
				session: "s-1",
				address: "VKCF3Z",
				windows: [held("33", "pi-session.1")],
			},
		]);
	});
});
