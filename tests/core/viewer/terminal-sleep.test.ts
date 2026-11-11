/** A parked conversation's terminal keeps its viewers and every key they type for the screen it wakes into. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ambientSession } from "../../../lib/core/session/index.ts";
import { ViewerTerminal } from "../../../lib/core/viewer/terminal.ts";

const terminals: ViewerTerminal[] = [];
afterEach(() => {
	for (const terminal of terminals.splice(0)) terminal.dispose();
});

const viewer = () => ({
	rows: 40,
	columns: 120,
	write: vi.fn(),
	disconnect: vi.fn(),
});

/** A terminal on conversation "a", its screen started, with what each screen read. */
function parkable() {
	const terminal = new ViewerTerminal("a", () => {});
	terminals.push(terminal);
	const first: string[] = [];
	terminal.start(
		(data) => first.push(data),
		() => {},
	);
	return { terminal, first };
}

/** Park it as the host does: hold keys, then stop the screen. */
function park(terminal: ViewerTerminal) {
	const wakes: (string | undefined)[] = [];
	terminal.sleep(() => wakes.push(ambientSession()));
	terminal.stop();
	return wakes;
}

/** Start the screen it wakes into, which reads into `read`. */
function wakeInto(terminal: ViewerTerminal, read: string[]) {
	terminal.start(
		(data) => read.push(data),
		() => {},
	);
}

describe("a parked conversation's terminal", () => {
	it("holds what its viewers type, says the first key once, and gives them all to its next screen in order", () => {
		const { terminal, first } = parkable();
		const one = terminal.attach(viewer());
		const two = terminal.attach(viewer());
		const wakes = park(terminal);

		one.input("ty");
		two.input("pe");
		one.input("d");
		expect(
			wakes,
			"the first key asked for the wake, in its conversation",
		).toEqual(["a"]);
		expect(
			terminal.isAsleep(),
			"it sleeps until its next screen takes the keys",
		).toBe(true);

		const next: string[] = [];
		wakeInto(terminal, next);
		two.input("!");
		expect(
			next,
			"the screen just started reads nothing before it is awake",
		).toEqual([]);
		terminal.awake();
		one.input(" after");

		expect(first, "the screen that parked read none of it").toEqual([]);
		expect(next, "the woken screen read every key, in the order typed").toEqual(
			["ty", "pe", "d", "!", " after"],
		);
		expect(wakes, "it asked for the wake once").toHaveLength(1);
		expect(terminal.isAsleep(), "awake, it holds nothing").toBe(false);
	});

	it("drops the keys of a viewer who left before it woke", () => {
		const { terminal } = parkable();
		const one = terminal.attach(viewer());
		const two = terminal.attach(viewer());
		park(terminal);

		one.input("gone");
		two.input("kept");
		one.detach();
		const next: string[] = [];
		wakeInto(terminal, next);
		terminal.awake();

		expect(next, "only the viewer still there is read").toEqual(["kept"]);
	});

	it("cuts off a viewer who types over its bound while it wakes, leaving the other", () => {
		const { terminal } = parkable();
		const flooding = viewer();
		const one = terminal.attach(flooding);
		const two = terminal.attach(viewer());
		park(terminal);

		one.input("a".repeat(1024 * 1024 + 1));
		two.input("b");
		const next: string[] = [];
		wakeInto(terminal, next);
		terminal.awake();

		expect(
			flooding.disconnect,
			"the flooding viewer was cut off",
		).toHaveBeenCalledWith(
			"Viewer typed over 1 MiB while its conversation woke",
		);
		expect(next, "the other viewer's key was read").toEqual(["b"]);
	});

	it("closed while parked, holds and wakes nothing", () => {
		const { terminal } = parkable();
		const one = terminal.attach(viewer());
		const wakes = park(terminal);
		terminal.dispose();

		one.input("late");

		expect(wakes, "nothing asks a closed conversation to wake").toEqual([]);
		expect(terminal.isAsleep(), "a closed terminal is not parked").toBe(false);
	});
});
