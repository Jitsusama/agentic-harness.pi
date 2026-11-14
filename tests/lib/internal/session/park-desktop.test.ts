/**
 * Closing a parking session's window through niri, the launcher and
 * kitty, run as programs from pi's own process.
 */

import { describe, expect, it } from "vitest";
import {
	closeWindow,
	keepPlace,
	leaveScreen,
	onNiri,
	type Run,
	readScreen,
} from "../../../../lib/internal/session/park-desktop.ts";
import type { HeldWindow } from "../../../../lib/internal/session/park-window.ts";

const SOCKET = "unix:/run/user/1000/pi-sessions/kitty.sock";
const WINDOW: HeldWindow = {
	terminal: "kitty",
	id: "33",
	within: SOCKET,
	appId: "pi-session.1",
};

interface Desk {
	/** The workspace the session's niri window is on. */
	workspace?: number;
	focused?: boolean;
	kept?: string;
	kittyClass?: string;
	fails?: string;
}

/** A desktop answering as niri, the shell and kitty do; records each call. */
function desk(given: Desk = {}): { run: Run; calls: string[] } {
	const calls: string[] = [];
	const run: Run = (program, args) => {
		const call = [program, ...args].join(" ");
		calls.push(call);
		if (given.fails !== undefined && call.includes(given.fails)) {
			throw new Error("failed");
		}
		if (call === "niri msg --json windows") {
			return JSON.stringify([
				{
					id: 7,
					app_id: "pi-session.1",
					workspace_id: given.workspace ?? 3,
					is_focused: given.focused ?? false,
				},
			]);
		}
		if (call === "niri msg --json workspaces") {
			return JSON.stringify([
				{ id: 1, is_active: true, is_focused: true, output: "eDP-1" },
				{ id: 3, is_active: false, is_focused: false, output: "eDP-1" },
			]);
		}
		if (program === "qs") return `${given.kept ?? "kept"}\n`;
		if (call === `kitten @ --to ${SOCKET} ls`) {
			return JSON.stringify([
				{
					id: 2,
					wm_class: given.kittyClass ?? "pi-session.1",
					tabs: [{ windows: [{ id: 33 }] }],
				},
			]);
		}
		return "";
	};
	return { run, calls };
}

const CLOSE = `kitten @ --to ${SOCKET} close-window --match id:33`;

describe("leaveScreen", () => {
	it("keeps the place, then closes a window on a hidden workspace", () => {
		const { run, calls } = desk();
		expect(leaveScreen("s-1", [WINDOW], run)).toEqual({
			kind: "parks",
			closed: [WINDOW],
		});
		const kept = calls.indexOf("qs ipc call sessions keepPlace s-1");
		expect(kept).toBeGreaterThan(-1);
		expect(calls.indexOf(CLOSE)).toBeGreaterThan(kept);
	});

	it("refuses, closing and keeping nothing, when its window is focused", () => {
		const { run, calls } = desk({ focused: true });
		expect(leaveScreen("s-1", [WINDOW], run)).toEqual({
			kind: "refused",
			why: "its window is focused",
		});
		expect(calls.filter((one) => !one.startsWith("niri "))).toEqual([]);
	});

	it("refuses when its window is on the workspace in sight", () => {
		const { run, calls } = desk({ workspace: 1 });
		expect(leaveScreen("s-1", [WINDOW], run).kind).toBe("refused");
		expect(calls).not.toContain(CLOSE);
	});

	it("parks with its window open when the launcher doesn't keep its place", () => {
		const { run, calls } = desk({ kept: "no window to keep" });
		expect(leaveScreen("s-1", [WINDOW], run)).toEqual({
			kind: "parks",
			closed: [],
			open: "the launcher didn't keep its place: no window to keep",
		});
		expect(calls).not.toContain(CLOSE);
	});

	it("parks with its window open when the launcher can't be asked", () => {
		const { run, calls } = desk({ fails: "qs ipc" });
		expect(leaveScreen("s-1", [WINDOW], run)).toMatchObject({
			kind: "parks",
			closed: [],
		});
		expect(calls).not.toContain(CLOSE);
	});

	it("parks with its window open when niri can't be read", () => {
		const { run, calls } = desk({ fails: "niri msg" });
		expect(leaveScreen("s-1", [WINDOW], run)).toEqual({
			kind: "parks",
			closed: [],
			open: "niri can't be read",
		});
		expect(calls.some((one) => one.startsWith("qs"))).toBe(false);
	});

	it("asks nothing of a session with no window", () => {
		const { run, calls } = desk();
		expect(leaveScreen("s-1", [], run)).toEqual({ kind: "parks", closed: [] });
		expect(calls).toEqual([]);
	});
});

describe("closeWindow", () => {
	it("closes nothing when kitty's window of that id is another's", () => {
		const { run, calls } = desk({ kittyClass: "pi-session.9" });
		expect(closeWindow(WINDOW, run)).toBe(
			"kitty shows no window 33 of class pi-session.1",
		);
		expect(calls).not.toContain(CLOSE);
	});

	it("says so when kitty fails to close it", () => {
		const { run } = desk({ fails: "close-window" });
		expect(closeWindow(WINDOW, run)).toBe("kitty didn't close window 33");
	});
});

describe("keepPlace", () => {
	it("answers what the launcher said, trimmed", () => {
		expect(keepPlace("s-1", desk().run)).toBe("kept");
	});
});

describe("readScreen", () => {
	it("reads nothing when niri answers something that isn't JSON", () => {
		expect(readScreen(() => "not json")).toBeUndefined();
	});
});

describe("onNiri", () => {
	it("is on niri only where niri named its socket", () => {
		expect(onNiri({ NIRI_SOCKET: "/run/user/1000/niri.sock" })).toBe(true);
		expect(onNiri({})).toBe(false);
	});
});
