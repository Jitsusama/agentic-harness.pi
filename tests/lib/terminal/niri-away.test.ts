/**
 * A window opened for a session never lands on the workspace Joel is
 * looking at: beside its orchestrator when that is elsewhere, else on
 * an empty workspace, his screen's first.
 */

import { describe, expect, it } from "vitest";
import {
	emptyAwayFromFocus,
	type NiriCall,
	placeWindow,
	workspacesIn,
} from "../../../lib/terminal/niri.ts";

const lead = "π - Lead - core.nix";

/** One workspace as niri lists it. */
function space(
	id: number,
	idx: number,
	output: string,
	focused: boolean,
	windowId: number | null,
) {
	return { id, idx, output, is_focused: focused, active_window_id: windowId };
}

/** A niri holding these windows and workspaces, taking every ask. */
function desk(windows: unknown[], workspaces: unknown[]) {
	const asked: unknown[] = [];
	const call: NiriCall = async (request) => {
		asked.push(request);
		if (request === "Windows") return { Ok: { Windows: windows } };
		if (request === "Workspaces") return { Ok: { Workspaces: workspaces } };
		return { Ok: "Handled" };
	};
	return { asked, call };
}

describe("an empty workspace away from focus", () => {
	it("is the focused screen's lowest, before another screen's", () => {
		const workspaces = workspacesIn({
			Ok: {
				Workspaces: [
					space(9, 1, "HDMI-1", false, null),
					space(1, 1, "eDP-1", true, 4),
					space(7, 4, "eDP-1", false, null),
					space(6, 3, "eDP-1", false, null),
				],
			},
		});
		expect(emptyAwayFromFocus(workspaces)).toBe(6);
	});

	it("is never the focused one, though it is empty", () => {
		const workspaces = workspacesIn({
			Ok: { Workspaces: [space(1, 1, "eDP-1", true, null)] },
		});
		expect(emptyAwayFromFocus(workspaces)).toBeUndefined();
	});

	it("reads nothing from a reply that isn't a list of workspaces", () => {
		expect(workspacesIn({ Err: "no" })).toEqual([]);
		expect(workspacesIn({ Ok: { Workspaces: [{ id: "x" }] } })).toEqual([]);
	});
});

describe("placing a window away from Joel's eyes", () => {
	it("goes to an empty workspace when its orchestrator's is the one he is at", async () => {
		const niri = desk(
			[{ title: lead, workspace_id: 1 }],
			[space(1, 1, "eDP-1", true, 4), space(8, 2, "eDP-1", false, null)],
		);
		const placed = await placeWindow(
			niri.call,
			{ beside: [lead], first: lead, title: "π - Mine - core.nix" },
			"pi-spawned.2",
		);

		expect(placed).toEqual({
			windowClass: "pi-spawned.2",
			workspace: 8,
			asked: true,
			away: true,
		});
		expect(niri.asked[2]).toEqual({
			Action: {
				OpenNextWindowOn: { app_id: "pi-spawned.2", reference: { Id: 8 } },
			},
		});
	});

	it("goes to an empty workspace when no window it names is found", async () => {
		const niri = desk(
			[],
			[space(1, 1, "eDP-1", true, 4), space(8, 2, "eDP-1", false, null)],
		);
		const placed = await placeWindow(niri.call, { beside: [lead] });

		expect(placed).toMatchObject({ workspace: 8, away: true });
	});

	it("stays beside its orchestrator when that workspace isn't focused", async () => {
		const niri = desk(
			[{ title: lead, workspace_id: 5 }],
			[space(1, 1, "eDP-1", true, 4), space(5, 2, "eDP-1", false, 9)],
		);
		const placed = await placeWindow(niri.call, { beside: [lead] });

		expect(placed).toMatchObject({ workspace: 5, asked: true });
		expect(placed?.away).toBeUndefined();
	});

	it("is left where niri puts it when niri lists nowhere else", async () => {
		const niri = desk([], [space(1, 1, "eDP-1", true, 4)]);
		expect(await placeWindow(niri.call, { beside: [lead] })).toBeUndefined();
	});
});
