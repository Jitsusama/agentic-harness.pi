/**
 * Where a session's window stands as the cutover plans: matched from
 * mycelium's window to kitty's OS window to niri's by title, with the
 * holder judged against the system's mycelium. The shapes are those the
 * machine printed on 11 November.
 */
import { describe, expect, it } from "vitest";
import {
	type MachineWindows,
	parseFocusedWorkspace,
	parseHeldSessions,
	parseKittyWindows,
	parseNiriWindows,
	standingOf,
} from "../../../host/cutover/windows.ts";

const SYSTEM = "/nix/store/new-mycelium/bin/mycelium";

const machine = (over: Partial<MachineWindows> = {}): MachineWindows => ({
	sessions: [
		{
			session: "s1",
			held: "h1",
			window: { within: "unix:@kitty-1", id: "133" },
		},
		{
			session: "s2",
			held: "h2",
			window: { within: "unix:@kitty-1", id: "159" },
		},
		{ session: "bare" },
	],
	niri: [
		{ title: "π - Network - core.nix", workspace: 8 },
		{ title: "π - Agentic loop", workspace: 11 },
	],
	focused: 8,
	kitties: new Map([
		[
			"unix:@kitty-1",
			[
				{ windows: ["133"], title: "π - Network - core.nix" },
				{ windows: ["159", "160"], title: "π - Agentic loop" },
			],
		],
	]),
	holders: new Map([
		["h1", { pid: 10, exe: SYSTEM }],
		["h2", { pid: 20, exe: "/nix/store/old-mycelium/bin/mycelium" }],
	]),
	mycelium: SYSTEM,
	...over,
});

describe("standingOf", () => {
	it("says a window on Joel's focused workspace is his", () => {
		expect(standingOf("s1", machine())).toEqual({ where: "joel" });
	});

	it("says a window elsewhere is away, naming a holder older than the system's", () => {
		expect(standingOf("s2", machine())).toEqual({
			where: "away",
			oldHolder: 20,
		});
	});

	it("knows no window of a session with none", () => {
		expect(standingOf("bare", machine())).toBeUndefined();
		expect(standingOf("unknown", machine())).toBeUndefined();
	});

	it("counts a title shown on Joel's workspace among several as his", () => {
		const twice = machine({
			niri: [
				{ title: "π - Agentic loop", workspace: 11 },
				{ title: "π - Agentic loop", workspace: 8 },
			],
		});
		expect(standingOf("s2", twice)?.where).toBe("joel");
	});

	it("leaves a window unplaced where kitty, niri or the machine can't say", () => {
		expect(standingOf("s1", machine({ kitties: new Map() }))?.where).toEqual({
			unplaced: "kitty unix:@kitty-1 has no window 133",
		});
		expect(standingOf("s1", machine({ niri: [] }))?.where).toEqual({
			unplaced: 'niri shows no window titled "π - Network - core.nix"',
		});
		expect(standingOf("s1", machine({ focused: undefined }))?.where).toEqual({
			unplaced: "niri has no workspace focused",
		});
		expect(
			standingOf("s2", machine({ unread: "niri didn't answer: gone" })),
		).toEqual({
			where: { unplaced: "niri didn't answer: gone" },
			oldHolder: 20,
		});
	});

	it("judges no holder whose executable or the system's can't be read", () => {
		expect(standingOf("s2", machine({ mycelium: undefined }))).toEqual({
			where: "away",
		});
		expect(
			standingOf(
				"s2",
				machine({ holders: new Map([["h2", { pid: 20, exe: undefined }]]) }),
			),
		).toEqual({ where: "away" });
	});
});

describe("parsing what the machine prints", () => {
	it("reads mycelium's sessions, each with its hold and kitty window", () => {
		const printed = JSON.stringify({
			Ok: {
				Sessions: [
					{
						address: "B8RBNW",
						held: "410b11f2",
						window: {
							terminal: "kitty",
							id: "133",
							within: "unix:@kitty-2684",
						},
						presence: { session: "01a1c300" },
					},
					{ address: "ELSEWHERE", presence: { session: "01a1c400" } },
					{ address: "NOPRESENCE" },
				],
			},
		});
		expect(parseHeldSessions(`${printed}\n`)).toEqual([
			{
				session: "01a1c300",
				held: "410b11f2",
				window: { within: "unix:@kitty-2684", id: "133" },
			},
			{ session: "01a1c400" },
		]);
	});

	it("reads niri's windows and its focused workspace", () => {
		expect(
			parseNiriWindows(
				JSON.stringify([
					{ id: 435, title: "π - Network", workspace_id: 8 },
					{ id: 7, title: null, workspace_id: null },
				]),
			),
		).toEqual([
			{ title: "π - Network", workspace: 8 },
			{ title: "", workspace: undefined },
		]);
		expect(
			parseFocusedWorkspace(
				JSON.stringify([
					{ id: 23, is_focused: false },
					{ id: 8, is_focused: true },
				]),
			),
		).toBe(8);
		expect(parseFocusedWorkspace("[]")).toBeUndefined();
	});

	it("titles each kitty OS window as its active tab, as niri shows it", () => {
		expect(
			parseKittyWindows(
				JSON.stringify([
					{
						id: 133,
						tabs: [
							{ is_active: false, title: "other", windows: [{ id: 134 }] },
							{ is_active: true, title: "π - Network", windows: [{ id: 133 }] },
						],
					},
				]),
			),
		).toEqual([{ windows: ["134", "133"], title: "π - Network" }]);
	});
});
