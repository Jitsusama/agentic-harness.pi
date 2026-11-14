/**
 * Closing a parking session's window through niri, the launcher and
 * kitty, run as programs from pi's own process.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	closeWindow,
	type Desk,
	inSight,
	keepPlaceAsleep,
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

let folder: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "park-desktop-"));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

interface Given {
	/** The workspace the session's niri window is on. */
	workspace?: number;
	focused?: boolean;
	/** No output on, as with the lid shut. */
	off?: boolean;
	kept?: string;
	kittyClass?: string;
	fails?: string;
}

/** A desktop answering as niri, the shell and kitty do; records each call. */
function desk(given: Given = {}): Desk & { calls: string[] } {
	const calls: string[] = [];
	const output = given.off ? null : "eDP-1";
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
					focus_timestamp: { secs: 10, nanos: 0 },
				},
				{
					id: 8,
					app_id: "chrome",
					workspace_id: 4,
					is_focused: false,
					focus_timestamp: { secs: 90, nanos: 0 },
				},
			]);
		}
		if (call === "niri msg --json workspaces") {
			return JSON.stringify([
				{ id: 1, is_active: !given.off, is_focused: !given.off, output },
				{ id: 3, is_active: false, is_focused: false, output },
				{ id: 4, is_active: false, is_focused: false, output },
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
	return { run, memory: join(folder, "screen.json"), calls };
}

const CLOSE = `kitten @ --to ${SOCKET} close-window --match id:33`;
const KEEP = "qs ipc call sessions keepPlaceAsleep s-1";

describe("leaveScreen", () => {
	it("keeps the place asleep, then closes a window on a hidden workspace", () => {
		const at = desk();
		expect(leaveScreen("s-1", [WINDOW], at)).toEqual({
			kind: "parks",
			closed: [WINDOW],
		});
		const kept = at.calls.indexOf(KEEP);
		expect(kept).toBeGreaterThan(-1);
		expect(at.calls.indexOf(CLOSE)).toBeGreaterThan(kept);
	});

	it("refuses, closing and keeping nothing, when its window is focused", () => {
		const at = desk({ focused: true });
		expect(leaveScreen("s-1", [WINDOW], at)).toEqual({
			kind: "refused",
			why: "its window is focused",
		});
		expect(at.calls.filter((one) => !one.startsWith("niri "))).toEqual([]);
	});

	it("refuses when its window is on the workspace in sight", () => {
		const at = desk({ workspace: 1 });
		expect(leaveScreen("s-1", [WINDOW], at).kind).toBe("refused");
		expect(at.calls).not.toContain(CLOSE);
	});

	it("parks with its window open when the launcher doesn't keep its place", () => {
		const at = desk({ kept: "no window to keep" });
		expect(leaveScreen("s-1", [WINDOW], at)).toEqual({
			kind: "parks",
			closed: [],
			open: "the launcher didn't keep its place: no window to keep",
		});
		expect(at.calls).not.toContain(CLOSE);
	});

	it("parks with its window open when the launcher can't be asked", () => {
		const at = desk({ fails: "qs ipc" });
		expect(leaveScreen("s-1", [WINDOW], at)).toMatchObject({
			kind: "parks",
			closed: [],
		});
		expect(at.calls).not.toContain(CLOSE);
	});

	it("parks with its window open when niri can't be read", () => {
		const at = desk({ fails: "niri msg" });
		expect(leaveScreen("s-1", [WINDOW], at)).toEqual({
			kind: "parks",
			closed: [],
			open: "niri can't be read",
		});
		expect(at.calls.some((one) => one.startsWith("qs"))).toBe(false);
	});

	it("asks nothing of a session with no window", () => {
		const at = desk();
		expect(leaveScreen("s-1", [], at)).toEqual({ kind: "parks", closed: [] });
		expect(at.calls).toEqual([]);
	});
});

describe("with the screen off", () => {
	it("keeps the workspace shown before it went off in sight", () => {
		// Read once while on, with workspace 1 shown and focused.
		const on = desk({ workspace: 1 });
		expect(inSight([WINDOW], on)).toBe("its window is on a workspace in sight");
		const off = desk({ off: true, workspace: 1 });
		expect(inSight([WINDOW], off)).toBe(
			"its window is on a workspace shown as the screen went off",
		);
	});

	it("closes nothing with nothing remembered from the screen on", () => {
		const off = desk({ off: true, workspace: 3 });
		expect(leaveScreen("s-1", [WINDOW], off)).toEqual({
			kind: "parks",
			closed: [],
			open: "the screen is off, and nothing is remembered of what it showed",
		});
		expect(off.calls).not.toContain(KEEP);
		expect(off.calls).not.toContain(CLOSE);
	});

	it("keeps the last focused window's workspace in sight", () => {
		inSight([WINDOW], desk({ workspace: 3 }));
		const off = desk({ off: true, workspace: 4 });
		expect(inSight([WINDOW], off)).toBe(
			"its window is on a workspace shown as the screen went off",
		);
	});

	it("closes a window on a workspace neither shown last nor focused last", () => {
		inSight([WINDOW], desk({ workspace: 3 }));
		const off = desk({ off: true, workspace: 3 });
		expect(leaveScreen("s-1", [WINDOW], off)).toEqual({
			kind: "parks",
			closed: [WINDOW],
		});
	});
});

describe("inSight", () => {
	it("lets a session park when niri can't be read", () => {
		expect(inSight([WINDOW], desk({ fails: "niri msg" }))).toBeUndefined();
	});
});

describe("closeWindow", () => {
	it("closes nothing when kitty's window of that id is another's", () => {
		const at = desk({ kittyClass: "pi-session.9" });
		expect(closeWindow(WINDOW, at.run)).toBe(
			"kitty shows no window 33 of class pi-session.1",
		);
		expect(at.calls).not.toContain(CLOSE);
	});

	it("says so when kitty fails to close it", () => {
		expect(closeWindow(WINDOW, desk({ fails: "close-window" }).run)).toBe(
			"kitty didn't close window 33",
		);
	});
});

describe("keepPlaceAsleep", () => {
	it("answers what the launcher said, trimmed", () => {
		expect(keepPlaceAsleep("s-1", desk().run)).toBe("kept");
	});
});

describe("readScreen", () => {
	it("reads nothing when niri answers something that isn't JSON", () => {
		expect(
			readScreen({ run: () => "not json", memory: join(folder, "m.json") }),
		).toBeUndefined();
	});
});

describe("onNiri", () => {
	it("is on niri only where niri named its socket", () => {
		expect(onNiri({ NIRI_SOCKET: "/run/user/1000/niri.sock" })).toBe(true);
		expect(onNiri({})).toBe(false);
	});
});
