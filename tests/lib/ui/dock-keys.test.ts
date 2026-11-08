/**
 * What the dock counts as typing. A gate waits for the person to stop
 * typing before it takes focus, so a focus or mouse report counted as a
 * key holds it back while they are elsewhere.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lastKeyAt, watchKeys } from "../../../lib/ui/dock.ts";
import { FOCUS_IN, FOCUS_OUT } from "../../../lib/ui/terminal-reports.ts";

/** A terminal context whose input reaches the returned `send`. */
function watched() {
	let listener: ((data: string) => unknown) | undefined;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			onTerminalInput: (handler: (data: string) => unknown) => {
				listener = handler;
				return () => {
					listener = undefined;
				};
			},
		},
	} as unknown as ExtensionContext;
	const stop = watchKeys(ctx);
	return { send: (data: string) => listener?.(data), stop };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("the dock's typing", () => {
	it("counts a key, not focus moving or the mouse", () => {
		vi.useFakeTimers();
		const { send, stop } = watched();
		vi.setSystemTime(1_000_000);
		send("a");
		vi.setSystemTime(2_000_000);
		send(FOCUS_OUT);
		send(FOCUS_IN);
		send("\x1b[<35;10;5M");
		send("\x1b[<0;10;5M");
		expect(lastKeyAt()).toEqual(1_000_000);
		send("b");
		expect(lastKeyAt()).toEqual(2_000_000);
		stop();
	});
});
