/** Viewer lifetime, geometry and input dispatch through the session seam. */
import {
	isKittyProtocolActive,
	setKittyProtocolActive,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ambientSession,
	type Host,
	installHost,
	sessionEnv,
	withSession,
} from "../../../lib/core/session/index.ts";
import { ViewerTerminal } from "../../../lib/core/viewer/terminal.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.useRealTimers();
});
function viewer(rows = 40, columns = 120) {
	return { rows, columns, write: vi.fn(), disconnect: vi.fn() };
}
/** A viewer whose client can run an editor and suspend itself. */
function able(rows = 40, columns = 120) {
	return {
		...viewer(rows, columns),
		features: ["edit", "suspend"],
		edit: vi.fn<(id: string, text: string) => void>(),
		suspend: vi.fn(),
	};
}
/** A screen whose Ctrl+G edits "draft" and whose Ctrl+Z suspends, as pi's does. */
function screen() {
	const terminal = new ViewerTerminal("a", () => terminal.write("painted"));
	const edits: Promise<unknown>[] = [];
	const suspended: boolean[] = [];
	terminal.start(
		(data) => {
			if (data === "\x07") edits.push(terminal.editInViewer("draft"));
			if (data === "\x1a") suspended.push(terminal.suspendViewer());
		},
		() => {},
	);
	// pi's own modes, which a viewer leaving for its editor must be let out of.
	terminal.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
	cleanups.push(() => terminal.dispose());
	return { terminal, edits, suspended };
}
const RELEASED = "\x1b[<u\x1b[?2004l\x1b[?25h\x1b[?1000l\x1b[?1006l\x1b[?1049l";
const RESTORED =
	"\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?1049h\x1b[>7u\x1b[?2004h";
const writes = (sink: { write: { mock: { calls: unknown[][] } } }) =>
	sink.write.mock.calls.map(([data]) => data);
function host() {
	const close = vi.fn();
	const fake: Host = {
		kind: "pi-durable",
		key: "test-viewer",
		owner: { pid: 123, startedAt: 1 },
		holds: (id) => (["a", "b"].includes(id) ? "idle" : undefined),
		env: (id) => ({
			get: () => id,
			set: () => {},
			delete: () => {},
			snapshot: () => ({ MARKER: id }),
		}),
		hints: () => ({}),
		close,
		stamp: () => {},
	};
	cleanups.push(installHost(fake));
	return close;
}

describe("persistent viewer terminal", () => {
	it("fans out output and keeps the conversation alive after one viewer leaves", () => {
		const close = host();
		const repaint = vi.fn();
		const terminal = new ViewerTerminal("a", repaint);
		const one = viewer();
		const two = viewer();
		const attached = terminal.attach(one);
		terminal.attach(two);
		terminal.write("first");
		expect(one.write).toHaveBeenCalledWith("first");
		expect(two.write).toHaveBeenCalledWith("first");
		attached.detach();
		one.write.mockClear();
		terminal.write("second");
		expect(one.write).not.toHaveBeenCalled();
		expect(two.write).toHaveBeenLastCalledWith("second");
		expect(close).not.toHaveBeenCalled();
	});

	it("uses the smallest joined geometry and repaints even a same-size join", () => {
		const repaint = vi.fn();
		const terminal = new ViewerTerminal("a", repaint);
		const resize = vi.fn();
		terminal.start(() => {}, resize);
		const one = terminal.attach(viewer());
		const two = terminal.attach(viewer(24, 80));
		expect([terminal.rows, terminal.columns]).toEqual([24, 80]);
		two.resize(50, 70);
		expect([terminal.rows, terminal.columns]).toEqual([40, 70]);
		two.detach();
		expect([terminal.rows, terminal.columns]).toEqual([40, 120]);
		one.detach();
		expect([terminal.rows, terminal.columns]).toEqual([40, 120]);
		expect(resize).toHaveBeenCalledTimes(3);
		expect(repaint).toHaveBeenCalledTimes(5);
	});

	it("keeps split kitty sequences and bracketed pastes separate per viewer", () => {
		host();
		const input = vi.fn();
		const terminal = new ViewerTerminal("a", () => {});
		terminal.start(input, () => {});
		const one = terminal.attach(viewer());
		const two = terminal.attach(viewer());
		one.input("\x1b[97;5");
		two.input("x");
		one.input("u");
		one.input("\x1b[200~/private/image");
		two.input("y");
		one.input(".png\x1b[201~");
		expect(input.mock.calls.map(([data]) => data)).toEqual([
			"x",
			"\x1b[97;5u",
			"y",
			"\x1b[200~/private/image.png\x1b[201~",
		]);
		terminal.dispose();
	});

	it("routes input, delayed Escape, resize and repaint to their session in one host", () => {
		vi.useFakeTimers();
		host();
		const seen: string[] = [];
		const a = new ViewerTerminal("a", () =>
			seen.push(`paint:${ambientSession()}`),
		);
		const b = new ViewerTerminal("b", () =>
			seen.push(`paint:${ambientSession()}`),
		);
		for (const terminal of [a, b]) {
			terminal.start(
				(data) =>
					seen.push(
						`${ambientSession()}:${sessionEnv().get("MARKER")}:${data}`,
					),
				() => seen.push(`resize:${ambientSession()}`),
			);
		}
		const one = a.attach(viewer(24, 80));
		const two = b.attach(viewer());
		seen.length = 0;
		one.input("\x1b");
		two.input("b");
		vi.advanceTimersByTime(60);
		one.resize(25, 80);
		expect(seen).toEqual(["b:b:b", "a:a:\x1b", "resize:a", "paint:a"]);
		expect(ambientSession()).toBeUndefined();
		a.dispose();
		b.dispose();
	});

	it("keeps its viewers across a rebind and dispatches under the new session", () => {
		host();
		const seen: string[] = [];
		const terminal = new ViewerTerminal("a", () =>
			seen.push(`paint:${ambientSession()}`),
		);
		terminal.start(
			(data) => seen.push(`${ambientSession()}:${data}`),
			() => {},
		);
		const one = viewer();
		const attached = terminal.attach(one);
		seen.length = 0;
		terminal.rebind("b");
		attached.input("x");
		terminal.write("after");
		expect(terminal.sessionId).toBe("b");
		expect(seen).toEqual(["paint:b", "b:x"]);
		expect(one.write).toHaveBeenLastCalledWith("after");
		expect(one.disconnect).not.toHaveBeenCalled();
		terminal.dispose();
	});

	it("draws pi's frames as the conversation it shows, whoever asked, across a rebind", () => {
		host();
		const terminal = new ViewerTerminal("a", () => {});
		terminal.attach(viewer());
		const drawn: (string | undefined)[] = [];
		const draw = () => drawn.push(ambientSession());
		terminal.renderScope(draw);
		withSession("b", () => terminal.renderScope(draw));
		terminal.rebind("b");
		withSession("a", () => terminal.renderScope(draw));
		expect(drawn).toEqual(["a", "a", "b"]);
		terminal.dispose();
	});

	it("draws no frame while nobody watches, and paints in full for whoever joins", () => {
		const repaint = vi.fn();
		const terminal = new ViewerTerminal("a", repaint);
		cleanups.push(() => terminal.dispose());
		const draw = vi.fn();

		terminal.renderScope(draw);
		expect(draw, "a frame nobody sees was drawn").not.toHaveBeenCalled();

		const joined = terminal.attach(viewer());
		expect(repaint, "the viewer joining wasn't painted").toHaveBeenCalledOnce();
		terminal.renderScope(draw);
		expect(draw, "a watched frame wasn't drawn").toHaveBeenCalledOnce();

		joined.detach();
		terminal.renderScope(draw);
		expect(draw, "a frame drew after its last viewer left").toHaveBeenCalledOnce();
	});

	it("discards a detached viewer's pending input and accepts a later viewer", () => {
		vi.useFakeTimers();
		const close = host();
		const input = vi.fn();
		const terminal = new ViewerTerminal("a", () => {});
		terminal.start(input, () => {});
		const one = terminal.attach(viewer());
		one.input("\x1b");
		one.detach();
		one.detach();
		vi.advanceTimersByTime(60);
		one.input("lost");
		terminal.write("unwatched panel");
		terminal.attach(viewer()).input("answer");
		expect(input.mock.calls.map(([data]) => data).join("")).toBe("answer");
		expect(close).not.toHaveBeenCalled();
		terminal.dispose();
	});

	it("bounds incomplete paste input and leaves its sibling able to type", () => {
		const terminal = new ViewerTerminal("a", () => {});
		const input = vi.fn();
		terminal.start(input, () => {});
		const sink = viewer();
		const one = terminal.attach(sink);
		const two = terminal.attach(viewer());
		one.input("\x1b[200~");
		one.input("a".repeat(1024 * 1024));
		two.input("b");
		expect(sink.disconnect).toHaveBeenCalledTimes(1);
		expect(input).toHaveBeenCalledExactlyOnceWith("b");
		terminal.dispose();
	});

	it("refuses invalid dimensions without changing geometry", () => {
		const terminal = new ViewerTerminal("a", () => {});
		for (const bad of [0, -1, 1.5, Number.NaN, 1001]) {
			expect(() => terminal.attach(viewer(bad, 80))).toThrow("dimensions");
		}
		const bad = viewer();
		const good = viewer();
		const one = terminal.attach(bad);
		terminal.attach(good);
		bad.write.mockClear();
		expect(() => one.resize(24, 0)).not.toThrow();
		expect(bad.disconnect).toHaveBeenCalledExactlyOnceWith(
			"Viewer dimensions must be integers from 1 to 1000",
		);
		terminal.write("sibling");
		expect(bad.write).not.toHaveBeenCalled();
		expect(good.write).toHaveBeenCalledWith("sibling");
		expect([terminal.rows, terminal.columns]).toEqual([40, 120]);
		terminal.dispose();
	});

	it("detaches a broken output sink without losing its sibling's output", () => {
		const terminal = new ViewerTerminal("a", () => {});
		const broken = viewer();
		const good = viewer();
		terminal.attach(broken);
		broken.write.mockImplementation(() => {
			throw new Error("closed");
		});
		broken.disconnect.mockImplementation(() => {
			throw new Error("already closed");
		});
		terminal.attach(good);
		terminal.write("still here");
		expect(good.write).toHaveBeenCalledWith("still here");
		expect(broken.disconnect).toHaveBeenCalledExactlyOnceWith(
			"Viewer output failed",
		);
		terminal.dispose();
		terminal.dispose();
		expect(() => terminal.attach(viewer())).toThrow("Conversation closed");
	});

	it("implements pi's terminal controls without a process tty", async () => {
		const terminal = new ViewerTerminal("a", () => {});
		const sink = viewer();
		terminal.attach(sink);
		terminal.start(
			() => {},
			() => {},
		);
		terminal.moveBy(-2);
		terminal.hideCursor();
		terminal.clearLine();
		terminal.clearFromCursor();
		terminal.clearScreen();
		terminal.setTitle("pi\x1b]unsafe\x07");
		terminal.setProgress(true);
		terminal.setProgramStatus({
			state: "blocked",
			app: "pi",
			kind: "question",
		});
		await terminal.drainInput();
		terminal.stop();
		expect(sink.write.mock.calls.map(([data]) => data)).toEqual([
			"\x1b[>7u\x1b[?2004h",
			"\x1b[2A",
			"\x1b[?25l",
			"\x1b[2K",
			"\x1b[0J",
			"\x1b[2J\x1b[H",
			"\x1b]0;pi ]unsafe \x07",
			"\x1b]9;4;3;\x07",
			"\x1b]7501;state=blocked:app=pi:kind=question\x1b\\",
			"\x1b[?25h",
		]);
		expect(
			terminal.kittyProtocolActive,
			"the kitty keyboard protocol stays on through pi's terminal controls",
		).toBe(true);
		terminal.dispose();
	});

	it("says when pi reports something waits on the person, until it closes", () => {
		const terminal = new ViewerTerminal("a", () => {});
		const blocked = vi.fn();
		terminal.whenBlocked(blocked);

		terminal.setProgramStatus({ state: "working" });
		terminal.setProgramStatus({ state: "blocked", kind: "question" });
		terminal.setProgramStatus({ state: "idle" });
		expect(blocked).toHaveBeenCalledOnce();

		terminal.dispose();
		terminal.setProgramStatus({ state: "blocked", kind: "permission" });
		expect(blocked, "a closed terminal hears nothing").toHaveBeenCalledOnce();
	});

	it("tells pi's key reader its viewers speak kitty's protocol once it starts", () => {
		setKittyProtocolActive(false);
		cleanups.push(() => setKittyProtocolActive(false));
		const terminal = new ViewerTerminal("a", () => {});
		expect(isKittyProtocolActive(), "nothing is claimed before it starts").toBe(
			false,
		);
		terminal.start(
			() => {},
			() => {},
		);
		expect(
			isKittyProtocolActive(),
			"as pi's own terminal does once kitty answers",
		).toBe(true);
		terminal.stop();
		expect(
			isKittyProtocolActive(),
			"one screen stopping leaves it on for the host's other screens",
		).toBe(true);
		terminal.dispose();
	});

	it("gives a late viewer pi's modes before its repaint, the screen last", () => {
		const terminal = new ViewerTerminal("a", () => terminal.write("painted"));
		terminal.write(
			"\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H\x1b[?25l",
		);
		terminal.write("\x1b[?2026hframe\x1b[?2026l\x1b[?10");
		terminal.write("04h\x1b[?1000l");
		terminal.write(`\x1b[?${"1".repeat(100)}`);
		terminal.write("h");
		const late = viewer();
		terminal.attach(late);
		expect(late.write.mock.calls.map(([data]) => data)).toEqual([
			"\x1b[?7l\x1b[?1006h\x1b[?25l\x1b[?1004h\x1b[?1000l\x1b[?1049h\x1b[>7u\x1b[?2004h",
			"painted",
		]);
		terminal.dispose();
	});

	it("refuses a viewer whose first output fails, leaving the others watching", () => {
		const terminal = new ViewerTerminal("a", () => {});
		const good = viewer();
		terminal.attach(good);
		const broken = viewer(10, 10);
		broken.write.mockImplementation(() => {
			throw new Error("closed");
		});
		expect(() => terminal.attach(broken)).toThrow("Viewer output failed");
		expect([terminal.rows, terminal.columns]).toEqual([40, 120]);
		terminal.write("still here");
		expect(good.write).toHaveBeenLastCalledWith("still here");
		terminal.dispose();
	});

	it("edits in the viewer that pressed the key, which sees nothing else until it answers", async () => {
		const { terminal, edits } = screen();
		const editing = able();
		const other = able();
		const attached = terminal.attach(editing);
		terminal.attach(other);
		attached.input("\x07");
		expect(
			other.edit,
			"only the viewer that pressed the key edits",
		).not.toHaveBeenCalled();
		const [[id, text] = []] = editing.edit.mock.calls;
		expect(text).toBe("draft");
		expect(
			writes(editing).at(-1),
			"its terminal is let out of pi's modes first",
		).toBe(RELEASED);
		editing.write.mockClear();
		terminal.write("frame");
		attached.input("\x1a");
		expect(writes(editing), "the editor has its terminal to itself").toEqual(
			[],
		);
		expect(other.write).toHaveBeenLastCalledWith("frame");

		attached.edited(String(id), "edited");

		await expect(edits[0]).resolves.toEqual({
			status: "complete",
			content: "edited",
		});
		expect(writes(editing), "back in pi's modes, then the screen").toEqual([
			RESTORED,
			"painted",
		]);
	});

	it("keeps the draft when an edit gives nothing back or its viewer leaves", async () => {
		const { terminal, edits } = screen();
		const first = able();
		const cancelling = terminal.attach(first);
		cancelling.input("\x07");
		cancelling.edited(String(first.edit.mock.calls[0]?.[0]));
		const second = able();
		const leaving = terminal.attach(second);
		leaving.input("\x07");
		leaving.detach();
		leaving.edited(String(second.edit.mock.calls[0]?.[0]), "too late");

		await expect(Promise.all(edits)).resolves.toEqual([
			{
				status: "failed",
				message: "The external editor gave nothing back; the draft is kept",
			},
			{
				status: "failed",
				message: "The viewer left before its edit came back",
			},
		]);
	});

	it("drops an answer to an edit it never asked, without leaving", () => {
		const { terminal } = screen();
		const sink = able();
		const attached = terminal.attach(sink);
		sink.write.mockClear();
		attached.edited("made-up", "text");
		terminal.write("still watching");
		expect(writes(sink)).toEqual(["still watching"]);
		expect(sink.disconnect).not.toHaveBeenCalled();
	});

	it("refuses an edit or a suspend for a viewer that can't, as pi's screen does", async () => {
		const { terminal, edits, suspended } = screen();
		const older = viewer();
		const attached = terminal.attach(older);
		older.write.mockClear();
		attached.input("\x07");
		attached.input("\x1a");
		await expect(edits[0]).resolves.toEqual({
			status: "failed",
			message: "The external editor is unavailable in this viewer",
		});
		expect(suspended).toEqual([false]);
		expect(
			writes(older),
			"an older client is sent nothing it can't read",
		).toEqual([]);
		expect(older.disconnect).not.toHaveBeenCalled();
	});

	it("suspends only the viewer that pressed the key, letting it out of pi's modes", () => {
		const { terminal, suspended } = screen();
		const stopping = able();
		const other = able();
		const attached = terminal.attach(stopping);
		terminal.attach(other);
		attached.input("\x1a");
		expect(suspended).toEqual([true]);
		expect(stopping.suspend).toHaveBeenCalledOnce();
		expect(writes(stopping).at(-1)).toBe(RELEASED);
		expect(other.suspend).not.toHaveBeenCalled();
		stopping.write.mockClear();
		terminal.write("frame");
		expect(writes(stopping), "a suspended viewer has left").toEqual([]);
		expect(other.write).toHaveBeenLastCalledWith("frame");
	});

	it("keeps no stray unfinished sequence as a mode", () => {
		const terminal = new ViewerTerminal("a", () => {});
		terminal.write("\x1b[?25");
		terminal.write("x\x1b[?25l");
		const late = viewer();
		terminal.attach(late);
		expect(late.write).toHaveBeenCalledWith("\x1b[?25l\x1b[>7u\x1b[?2004h");
		terminal.dispose();
	});
});
