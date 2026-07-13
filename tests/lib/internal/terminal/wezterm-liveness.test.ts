import { describe, expect, it } from "vitest";
import {
	classifyWeztermPanes,
	type WeztermObservation,
} from "../../../../lib/internal/terminal/drivers/wezterm";
import {
	type TerminalSessionHandle,
	terminalHandleKey,
} from "../../../../lib/terminal/index";

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

// Read a handle's probe result by its stable key, the way the
// snapshot builder looks it up, not by the bare pane value.
function probeOf(out: Map<string, unknown>, h: TerminalSessionHandle): unknown {
	return out.get(terminalHandleKey(h));
}

describe("classifyWeztermPanes", () => {
	it("marks a pane present when it is in the live set and host and scope match", () => {
		const h = handle("1");
		const out = classifyWeztermPanes([h], reachable(["1", "2"]));
		expect(probeOf(out, h)).toBe("present");
	});

	it("marks a pane absent when host and scope match but the pane is gone", () => {
		const h = handle("9");
		const out = classifyWeztermPanes([h], reachable(["1", "2"]));
		expect(probeOf(out, h)).toBe("absent");
	});

	it("marks a pane unknown when the recorded host differs", () => {
		const h = handle("1", { hostId: "host-b" });
		const out = classifyWeztermPanes([h], reachable(["1"]));
		expect(probeOf(out, h)).toBe("unknown");
	});

	it("marks a pane unknown when the recorded scope differs from the observed mux", () => {
		const h = handle("1", { scope: "/sock/gui-2" });
		const out = classifyWeztermPanes([h], reachable(["1"]));
		expect(probeOf(out, h)).toBe("unknown");
	});

	it("marks a pane unknown when it has no recorded scope", () => {
		const h = handle("1", { scope: undefined });
		const out = classifyWeztermPanes([h], reachable(["1"]));
		expect(probeOf(out, h)).toBe("unknown");
	});

	it("marks every pane unknown when the mux was unreachable", () => {
		const a = handle("1");
		const b = handle("2");
		const out = classifyWeztermPanes([a, b], { reachable: false });
		expect(probeOf(out, a)).toBe("unknown");
		expect(probeOf(out, b)).toBe("unknown");
	});

	it("does not collide two instances that share a pane id", () => {
		// Same pane value "0" on the observed mux and on a foreign one.
		const here = handle("0");
		const foreign = handle("0", { scope: "/sock/gui-2" });
		const out = classifyWeztermPanes([here, foreign], reachable(["0"]));
		expect(probeOf(out, here)).toBe("present");
		expect(probeOf(out, foreign)).toBe("unknown");
	});
});
