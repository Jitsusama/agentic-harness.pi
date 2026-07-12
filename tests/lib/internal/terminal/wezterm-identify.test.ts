import { hostname } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wezterm } from "../../../../lib/internal/terminal/drivers/wezterm";

let savedPane: string | undefined;
let savedSock: string | undefined;

beforeEach(() => {
	savedPane = process.env.WEZTERM_PANE;
	savedSock = process.env.WEZTERM_UNIX_SOCKET;
});
afterEach(() => {
	if (savedPane === undefined) delete process.env.WEZTERM_PANE;
	else process.env.WEZTERM_PANE = savedPane;
	if (savedSock === undefined) delete process.env.WEZTERM_UNIX_SOCKET;
	else process.env.WEZTERM_UNIX_SOCKET = savedSock;
});

describe("wezterm.identifyCurrent", () => {
	it("returns a wezterm-pane handle from WEZTERM_PANE and the socket scope", () => {
		process.env.WEZTERM_PANE = "7";
		process.env.WEZTERM_UNIX_SOCKET = "/sock/gui-99";
		const handle = wezterm.identifyCurrent();
		expect(handle).toEqual({
			driverId: "wezterm",
			kind: "wezterm-pane",
			hostId: hostname(),
			scope: "/sock/gui-99",
			value: "7",
		});
	});

	it("returns undefined when WEZTERM_PANE is not set", () => {
		delete process.env.WEZTERM_PANE;
		expect(wezterm.identifyCurrent()).toBeUndefined();
	});
});
