import { describe, expect, it } from "vitest";
import {
	classifyWeztermPanes,
	type WeztermObservation,
} from "../../../../lib/internal/terminal/drivers/wezterm";
import type { TerminalSessionHandle } from "../../../../lib/terminal/index";

const HOST = "host-a";
const SOCK = "/sock/gui-1";

function handle(
	value: string,
	overrides: Partial<TerminalSessionHandle> = {},
): TerminalSessionHandle {
	return {
		driverId: "wezterm",
		kind: "wezterm-pane",
		hostId: HOST,
		scope: SOCK,
		value,
		...overrides,
	};
}

const reachable = (live: string[]): WeztermObservation => ({
	reachable: true,
	hostId: HOST,
	scope: SOCK,
	livePaneIds: new Set(live),
});

describe("classifyWeztermPanes", () => {
	it("marks a pane present when it is in the live set and host and scope match", () => {
		const out = classifyWeztermPanes([handle("1")], reachable(["1", "2"]));
		expect(out.get("1")).toBe("present");
	});

	it("marks a pane absent when host and scope match but the pane is gone", () => {
		const out = classifyWeztermPanes([handle("9")], reachable(["1", "2"]));
		expect(out.get("9")).toBe("absent");
	});

	it("marks a pane unknown when the recorded host differs", () => {
		const out = classifyWeztermPanes(
			[handle("1", { hostId: "host-b" })],
			reachable(["1"]),
		);
		expect(out.get("1")).toBe("unknown");
	});

	it("marks a pane unknown when the recorded scope differs from the observed mux", () => {
		const out = classifyWeztermPanes(
			[handle("1", { scope: "/sock/gui-2" })],
			reachable(["1"]),
		);
		expect(out.get("1")).toBe("unknown");
	});

	it("marks a pane unknown when it has no recorded scope", () => {
		const out = classifyWeztermPanes(
			[handle("1", { scope: undefined })],
			reachable(["1"]),
		);
		expect(out.get("1")).toBe("unknown");
	});

	it("marks every pane unknown when the mux was unreachable", () => {
		const out = classifyWeztermPanes([handle("1"), handle("2")], {
			reachable: false,
		});
		expect(out.get("1")).toBe("unknown");
		expect(out.get("2")).toBe("unknown");
	});
});
