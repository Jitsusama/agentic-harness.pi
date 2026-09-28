/**
 * Every panel comes down when its session ends, and none waits past it.
 *
 * When a session ends (`/new`, `/resume`, `/fork`, `/reload`, quit), pi
 * resets the extension UI by hiding the topmost overlay. It never settles
 * the panel's promise and never disposes it. A panel raised outside a
 * turn has no turn signal to close on, so it was left answering nothing,
 * and since the gate queue is process-global and outlives a reload, it
 * held the screen for good: every panel asked for afterwards, in any
 * session, waited behind it. A panel still queued when its session ended
 * mounted in the next one, a question from a conversation nobody could
 * see any longer.
 *
 * `closeEveryPanel` is what a `session_shutdown` handler calls. Pi emits
 * that before its reset on every path except `/reload`, which resets
 * first, so both orders are held here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { overlaysLeft } from "../../../lib/ui/mount.ts";
import { promptSingle } from "../../../lib/ui/panel.ts";
import { closeEveryPanel } from "../../../lib/ui/panel-registry.ts";
import type { SinglePromptConfig } from "../../../lib/ui/types.ts";
import { Lines, type PiScreen, pinStdout, piScreen } from "./pi-screen.ts";

const COLUMNS = 120;
const ROWS = 30;
const ESCAPE = "\x1b";
const REGISTRY_KEY = Symbol.for("agentic-harness.open-panels");

const gate = (name: string): SinglePromptConfig => ({
	title: name,
	content: () => [`${name} body`],
	actions: [{ key: "r", label: "Reject" }],
});

describe("a panel when its session ends", () => {
	let s: PiScreen;
	let unpin: () => void;

	beforeEach(() => {
		unpin = pinStdout(COLUMNS, ROWS);
		s = piScreen(COLUMNS, ROWS);
	});

	afterEach(() => {
		// A failing case must not leave a panel holding the shared queue
		// for the cases after it.
		closeEveryPanel();
		s.stop();
		unpin();
	});

	it("comes down with its Escape answer, though no turn owns it", async () => {
		// No signal: raised by a command or an event, not a turn.
		const answer = promptSingle(s.ctx(), gate("GATE ONE"));
		expect(await s.settled()).toContain("GATE ONE body");

		expect(closeEveryPanel()).toBe(1);
		expect(await answer).toBeNull();
		expect(await s.settled()).not.toContain("GATE ONE body");
		expect(s.tui.hasOverlayEntries).toBe(false);
	});

	it("withdraws one still waiting, so it never mounts in the next session", async () => {
		const first = promptSingle(s.ctx(), gate("GATE ONE"));
		const second = promptSingle(s.ctx(), gate("GATE TWO"));
		await s.settled();

		expect(closeEveryPanel()).toBe(2);
		expect(await first).toBeNull();
		expect(await second).toBeNull();
		const screen = await s.settled();
		expect(screen).not.toContain("GATE ONE body");
		expect(screen).not.toContain("GATE TWO body");
		expect(s.tui.hasOverlayEntries).toBe(false);
	});

	it("leaves the screen free for the next session's panels", async () => {
		const stale = promptSingle(s.ctx(), gate("GATE ONE"));
		await s.settled();
		closeEveryPanel();
		await stale;

		const fresh = promptSingle(s.ctx(), gate("GATE NEXT"));
		expect(await s.settled()).toContain("GATE NEXT body");
		s.terminal.press(ESCAPE);
		expect(await fresh).toBeNull();
	});

	it("answers after pi's reset has already popped it, taking nothing else", async () => {
		// The /reload order: pi hides the topmost overlay, then emits
		// session_shutdown. What was under the panel stays.
		s.tui.showOverlay(new Lines(["FOREIGN PANEL"]), {
			anchor: "top-center",
			width: 30,
		});
		const answer = promptSingle(s.ctx(), gate("GATE ONE"));
		expect(await s.settled()).toContain("GATE ONE body");

		s.tui.hideOverlay();
		expect(closeEveryPanel()).toBe(1);
		expect(await answer).toBeNull();
		const screen = await s.settled();
		expect(screen).not.toContain("GATE ONE body");
		expect(screen).toContain("FOREIGN PANEL");
		expect(overlaysLeft(s.tui)).toBe(true);
	});

	it("counts nothing once every panel has answered", async () => {
		const answer = promptSingle(s.ctx(), gate("GATE ONE"));
		await s.settled();
		s.terminal.press(ESCAPE);
		await answer;
		expect(closeEveryPanel()).toBe(0);
	});

	it("is closed by another copy of the library through the shared registry", async () => {
		// A second package with its own lib/ui handles session_shutdown;
		// this copy's panels must come down all the same.
		const answer = promptSingle(s.ctx(), gate("GATE ONE"));
		await s.settled();
		const registry = Reflect.get(globalThis, REGISTRY_KEY) as {
			version: number;
			closeAll(): number;
		};
		expect(registry.version).toBe(1);
		expect(registry.closeAll()).toBe(1);
		expect(await answer).toBeNull();
	});
});

describe("the registry shared between copies", () => {
	it("is joined, not replaced, by a copy loaded after it", async () => {
		const g = globalThis as Record<symbol, unknown>;
		const saved = g[REGISTRY_KEY];
		const stops: Array<() => void> = [];
		const theirs = {
			version: 2,
			track(stop: () => void) {
				stops.push(stop);
				return () => {};
			},
			closeAll() {
				for (const stop of stops) stop();
				return stops.length;
			},
		};
		g[REGISTRY_KEY] = theirs;
		try {
			vi.resetModules();
			const copy = await import("../../../lib/ui/panel-registry.ts");
			const stop = vi.fn();
			copy.trackPanel(stop);
			expect(g[REGISTRY_KEY]).toBe(theirs);
			expect(copy.closeEveryPanel()).toBe(1);
			expect(stop).toHaveBeenCalledOnce();
		} finally {
			g[REGISTRY_KEY] = saved;
			vi.resetModules();
		}
	});
});
