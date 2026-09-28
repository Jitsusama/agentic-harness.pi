/**
 * A panel comes off the screen by its own handle, and only itself.
 *
 * Pi's close for an overlay hides whichever overlay is on top, not the
 * one it belongs to. So a panel that closes while another overlay sits
 * above it takes that one down and stays up itself: answered, invisible
 * to its caller, and still on screen with nothing listening. And a
 * panel on screen when its turn is stopped never closed at all; the
 * only way out was a key.
 *
 * These run on a real TUI and a real terminal emulator, through pi's
 * own mount (see `pi-screen.ts`), and assert what a person would see.
 */

import { TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { overlaysLeft } from "../../../lib/ui/mount.ts";
import { promptSingle, promptTabbed, view } from "../../../lib/ui/panel.ts";
import type {
	SinglePromptConfig,
	TabbedPromptConfig,
	ViewConfig,
} from "../../../lib/ui/types.ts";
import {
	Lines,
	type PiScreen,
	pinStdout,
	piScreen,
	VirtualTerminal,
} from "./pi-screen.ts";

const COLUMNS = 120;
const ROWS = 30;
const ESCAPE = "\x1b";

const gate = (name: string): SinglePromptConfig => ({
	title: name,
	content: () => [`${name} body`],
	actions: [{ key: "r", label: "Reject" }],
});

/** Another program's overlay, somewhere our panels are not. */
function foreign(s: PiScreen, nonCapturing = false) {
	return s.tui.showOverlay(new Lines(["FOREIGN PANEL"]), {
		anchor: "top-center",
		width: 30,
		nonCapturing,
	});
}

describe("what pi's screen says about its overlays", () => {
	// Read off pi's screen class rather than its interface, so an upgrade
	// that drops it has to fail here. Without it pi's close is never
	// called, which is safe, but every closed panel then leaks.
	it("counts every overlay on the stack, hidden ones too", () => {
		const tui = new TuiMainScreen(new VirtualTerminal(40, 10));
		expect(overlaysLeft(tui)).toBe(false);
		const handle = tui.showOverlay(new Lines(["x"]));
		expect(overlaysLeft(tui)).toBe(true);
		handle.setHidden(true);
		expect(overlaysLeft(tui)).toBe(true);
		handle.hide();
		expect(overlaysLeft(tui)).toBe(false);
	});
});

describe("a panel coming off the screen", () => {
	let s: PiScreen;
	let unpin: () => void;

	beforeEach(() => {
		unpin = pinStdout(COLUMNS, ROWS);
		s = piScreen(COLUMNS, ROWS);
	});

	afterEach(() => {
		s.stop();
		unpin();
	});

	it("closes on Escape, the baseline everything else is held to", async () => {
		const answer = promptSingle(s.ctx(), gate("GATE ONE"));
		expect(await s.settled()).toContain("GATE ONE body");
		s.terminal.press(ESCAPE);
		expect(await answer).toBeNull();
		expect(await s.settled()).not.toContain("GATE ONE body");
		expect(s.tui.hasOverlayEntries).toBe(false);
	});

	it("closes when its turn is stopped, answering as Escape does", async () => {
		const turn = new AbortController();
		const answer = promptSingle(s.ctx(turn.signal), gate("GATE ONE"));
		expect(await s.settled()).toContain("GATE ONE body");

		turn.abort();
		expect(await answer).toBeNull();
		expect(await s.settled()).not.toContain("GATE ONE body");
		expect(s.tui.hasOverlayEntries).toBe(false);
	});

	it("takes only itself down when stopped under another overlay", async () => {
		const turn = new AbortController();
		const answer = promptSingle(s.ctx(turn.signal), gate("GATE ONE"));
		await s.settled();
		foreign(s);
		expect(await s.settled()).toContain("FOREIGN PANEL");

		turn.abort();
		expect(await answer).toBeNull();
		const screen = await s.settled();
		expect(screen).not.toContain("GATE ONE body");
		expect(screen).toContain("FOREIGN PANEL");
	});

	it("takes only itself down on Escape under a non-capturing overlay", async () => {
		// Keys still reach the gate, so a person can answer it; pi's close
		// then hid the overlay above and left the answered gate up.
		const answer = promptSingle(s.ctx(), gate("GATE ONE"));
		await s.settled();
		foreign(s, true);
		expect(await s.settled()).toContain("FOREIGN PANEL");

		s.terminal.press(ESCAPE);
		expect(await answer).toBeNull();
		const screen = await s.settled();
		expect(screen).not.toContain("GATE ONE body");
		expect(screen).toContain("FOREIGN PANEL");
	});

	it("never shows, nor takes another down, when stopped as it mounts", async () => {
		// Pi hands out the handle only once the panel is built. Stopped in
		// between, pi's close would hide whatever overlay is on top.
		const under = foreign(s);
		await s.settled();
		under.focus();
		const turn = new AbortController();
		s.hooks.beforeShow = () => turn.abort();
		const answer = promptSingle(s.ctx(turn.signal), gate("GATE ONE"));

		expect(await answer).toBeNull();
		const screen = await s.settled();
		expect(screen).not.toContain("GATE ONE body");
		expect(screen).toContain("FOREIGN PANEL");
	});

	it("gives the screen to the next gate once it is gone", async () => {
		const turn = new AbortController();
		const first = promptSingle(s.ctx(turn.signal), gate("GATE ONE"));
		const second = promptSingle(s.ctx(), gate("GATE TWO"));
		let screen = await s.settled();
		expect(screen).toContain("GATE ONE body");
		expect(screen).not.toContain("GATE TWO body");

		turn.abort();
		expect(await first).toBeNull();
		screen = await s.settled();
		expect(screen).not.toContain("GATE ONE body");
		expect(screen).toContain("GATE TWO body");

		s.terminal.press(ESCAPE);
		expect(await second).toBeNull();
		expect(s.tui.hasOverlayEntries).toBe(false);
	});

	it("clears a tabbed gate's count when its turn is stopped", async () => {
		const turn = new AbortController();
		const answer = promptTabbed(s.ctx(turn.signal), {
			items: ["one", "two"].map((n) => ({
				label: n,
				views: [{ key: "c", label: "Body", content: () => [`tab ${n} body`] }],
			})),
			actions: [{ key: "r", label: "Reject" }],
		} satisfies TabbedPromptConfig);
		expect(await s.settled()).toContain("tab one body");

		turn.abort();
		expect(await answer).toBeNull();
		expect(await s.settled()).not.toContain("tab one body");
		expect(s.status.at(-1)).toBeUndefined();
	});

	it("closes a view by its own handle when it is dismissed", async () => {
		const dismiss = new AbortController();
		const shown = view(s.ctx(), {
			title: "A VIEW",
			content: () => ["view body"],
			signal: dismiss.signal,
		} as ViewConfig);
		await s.settled();
		foreign(s);
		expect(await s.settled()).toContain("view body");

		dismiss.abort();
		await shown;
		const screen = await s.settled();
		expect(screen).not.toContain("view body");
		expect(screen).toContain("FOREIGN PANEL");
	});
});
