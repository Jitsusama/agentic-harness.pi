/** A parked conversation's terminal keeps its viewers and every key they type for the screen it wakes into. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ambientSession } from "../../../lib/core/session/index.ts";
import { ViewerTerminal } from "../../../lib/core/viewer/terminal.ts";
import { until } from "../../support/until.ts";

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
	terminal.sleep(() => {
		wakes.push(ambientSession());
		return Promise.resolve();
	});
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
		// pi's stdin buffer splits what it reads into keys, so read them joined.
		expect(
			next.join(""),
			"the woken screen read every key, in the order typed",
		).toBe("typed! after");
		expect(wakes, "it asked for the wake once").toHaveLength(1);
		expect(terminal.isAsleep(), "awake, it holds nothing").toBe(false);
	});

	it("says a wake that failed, and asks again at the next key, every key still held", async () => {
		const { terminal } = parkable();
		const watching = viewer();
		const one = terminal.attach(watching);
		const refusals = ["the rollout gate said no"];
		const wakes = vi.fn(() => {
			const refused = refusals.shift();
			return refused === undefined
				? Promise.resolve()
				: Promise.reject(new Error(refused));
		});
		terminal.sleep(wakes);
		terminal.stop();

		one.input("first");
		await until("its window to say why the wake failed", () =>
			watching.write.mock.calls
				.map(([data]) => String(data))
				.join("")
				.includes(
					"Couldn't wake it: the rollout gate said no. A key tries again.",
				),
		);
		one.input(" second");
		expect(wakes, "the next key asked again").toHaveBeenCalledTimes(2);
		one.input(" third");
		expect(wakes, "a wake under way is asked once").toHaveBeenCalledTimes(2);
		const next: string[] = [];
		wakeInto(terminal, next);
		terminal.awake();

		expect(
			next.join(""),
			"the woken screen read every key, the failed wake's among them",
		).toBe("first second third");
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

		expect(next.join(""), "only the viewer still there is read").toBe("kept");
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
		expect(next.join(""), "the other viewer's key was read").toBe("b");
	});

	it("parking settles a quit still asked as unanswered, and holds that viewer's next key for the wake", async () => {
		const terminal = new ViewerTerminal("a", () => {});
		terminals.push(terminal);
		const verdicts: Promise<unknown>[] = [];
		terminal.start(
			(data) => {
				if (data === "\x04") verdicts.push(terminal.confirmQuit(false));
			},
			() => {},
		);
		const asked = viewer();
		const one = terminal.attach(asked);
		// A lone viewer's quit holds at once; it's asked only while another
		// window watches.
		terminal.attach(viewer());
		one.input("\x04");
		park(terminal);

		await expect(
			verdicts.at(0),
			"the quit doesn't hold once its screen parks",
		).resolves.toEqual({ holds: false });
		one.input("y");
		const next: string[] = [];
		wakeInto(terminal, next);
		terminal.awake();

		expect(asked.disconnect, "its viewer stays").not.toHaveBeenCalled();
		expect(next.join(""), "its y is a key for the wake, not an answer").toBe(
			"y",
		);
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
