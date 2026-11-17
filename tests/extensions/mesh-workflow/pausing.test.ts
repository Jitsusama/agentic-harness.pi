/**
 * Pause, Resume, Stop and Close from outside a session's window.
 */
import { describe, expect, it } from "vitest";
import {
	createPausing,
	type Pausing,
} from "../../../extensions/mesh-workflow/pausing.ts";

interface Session {
	idle: boolean;
	/** The time its pausing reads, in ms; it starts at 0. */
	time: number;
	readonly pausing: Pausing;
	readonly did: string[];
	readonly told: string[];
	/** Who each close said asked for it. */
	readonly closedBy: string[];
}

function session(
	idle: boolean,
	carry: (to: string) => Promise<void> = async () => {},
): Session {
	const did: string[] = [];
	const told: string[] = [];
	const closedBy: string[] = [];
	let paused = false;
	const state = { idle, time: 0 };
	const at: Session = {
		get idle() {
			return state.idle;
		},
		set idle(now) {
			state.idle = now;
		},
		get time() {
			return state.time;
		},
		set time(now) {
			state.time = now;
		},
		pausing: createPausing({
			now: () => state.time,
			idle: (): boolean => state.idle,
			abort: () => did.push("abort"),
			paused: () => paused,
			setPaused: (now) => {
				paused = now;
			},
			carryOn: () => did.push("carry on"),
			tell: (text) => told.push(text),
			close: (by) => {
				did.push("close");
				closedBy.push(by);
			},
			carry: async (to) => {
				did.push(`carry to ${to}`);
				await carry(to);
			},
		}),
		did,
		told,
		closedBy,
	};
	return at;
}

describe("pausing a session", () => {
	it("lets the turn under way finish, then ends every run until resumed", () => {
		const one = session(false);
		one.pausing.act("pause");
		expect(one.did).toEqual([]);
		one.pausing.turnEnded();
		expect(one.did).toEqual(["abort"]);

		one.idle = true;
		one.pausing.turnEnded();
		one.pausing.started();
		expect(one.did).toEqual(["abort", "abort"]);
		expect(one.pausing.paused, "the session stays paused until resumed").toBe(
			true,
		);

		one.pausing.act("resume");
		expect(one.pausing.paused, "resuming ends the pause").toBe(false);
		expect(one.did).toEqual(["abort", "abort", "carry on"]);
		one.pausing.started();
		expect(one.did).toHaveLength(3);
	});

	it("ends with a talk, or the person typing in the window, whose words are the turn", () => {
		const one = session(true);
		one.pausing.act("pause");
		one.pausing.talked();
		one.pausing.started();
		expect(one.pausing.paused, "a talk ends the pause").toBe(false);
		expect(one.did).toEqual([]);
	});

	it("resumes nothing that was not paused", () => {
		const one = session(true);
		one.pausing.act("resume");
		expect(one.did).toEqual([]);
	});
});

describe("stopping a session", () => {
	it("ends the run in progress at once and leaves it listening, unpaused", () => {
		const one = session(false);
		one.pausing.act("pause");
		one.pausing.act("stop");
		expect(one.did).toEqual(["abort"]);
		expect(one.pausing.paused, "a stop ends the pause").toBe(false);

		const idle = session(true);
		idle.pausing.act("stop");
		expect(idle.did).toEqual([]);
	});
});

/** A steer's `at`, written `ms` into the test's clock. */
function written(ms: number): string {
	return new Date(ms).toISOString();
}

describe("a stop or pause written before what it would end", () => {
	// A conversation that parks takes its inbox only as it starts again,
	// so a Stop pressed on a row still showing it under way was read on
	// the next wake, and ended the run a key the person typed had begun.
	it("drops a Stop written before the run in progress began", () => {
		const woken = session(true);
		woken.time = 2_000;
		woken.idle = false;
		woken.pausing.started();

		woken.pausing.act("stop", "joel", written(1_500));

		expect(woken.did, "the run the wake began goes on").toEqual([]);
		expect(woken.told.at(-1)).toContain("dropped");
		expect(woken.told.at(-1)).toContain(written(1_500));
	});

	it("drops a Pause written before the session last started", () => {
		// Pausing is made as the session starts, at 0 in the test's clock,
		// so a steer written at -500 was written while it was parked.
		const woken = session(true);
		woken.time = 2_000;
		woken.pausing.act("pause", "joel", written(-500));
		woken.idle = false;
		woken.pausing.started();
		woken.pausing.turnEnded();

		expect(woken.pausing.paused).toBe(false);
		expect(woken.did, "no run is ended").toEqual([]);
		expect(woken.told.at(-1)).toContain("dropped");
	});

	it("drops a Pause written before the run in progress began", () => {
		const one = session(true);
		one.time = 2_000;
		one.idle = false;
		one.pausing.started();

		one.pausing.act("pause", "joel", written(1_500));
		one.pausing.turnEnded();

		expect(one.pausing.paused).toBe(false);
		expect(one.did).toEqual([]);
	});

	it("still stops the run it was written during", () => {
		const one = session(true);
		one.time = 2_000;
		one.idle = false;
		one.pausing.started();

		one.pausing.act("stop", "joel", written(2_500));

		expect(one.did).toEqual(["abort"]);
	});

	it("still pauses after a run it was written during has ended", () => {
		const one = session(true);
		one.time = 2_000;
		one.idle = false;
		one.pausing.started();
		one.time = 3_000;
		one.idle = true;

		one.pausing.act("pause", "joel", written(2_500));
		one.pausing.started();

		expect(one.pausing.paused).toBe(true);
		expect(one.did, "the next run is ended as it starts").toEqual(["abort"]);
	});

	it("acts on a steer that says no time, or one it can't read, as written now", () => {
		for (const at of [undefined, "not a time"]) {
			const one = session(true);
			one.time = 2_000;
			one.idle = false;
			one.pausing.started();

			one.pausing.act("stop", "joel", at);

			expect(one.did, String(at)).toEqual(["abort"]);
		}
	});

	it("never drops a Close or a Resume for its time", () => {
		const closing = session(true);
		closing.time = 2_000;
		closing.pausing.started();
		closing.pausing.act("close", "joel", written(1_500));
		expect(closing.did).toEqual(["close"]);

		const resuming = session(true);
		resuming.pausing.act("pause");
		resuming.time = 2_000;
		resuming.pausing.started();
		resuming.pausing.act("resume", "joel", written(1_500));
		expect(resuming.pausing.paused).toBe(false);
	});
});

describe("closing a session", () => {
	it("ends the run in progress, then the session, as /exit does", () => {
		const busy = session(false);
		busy.pausing.act("close");
		expect(busy.did).toEqual(["abort", "close"]);

		const idle = session(true);
		idle.pausing.act("close");
		expect(idle.did).toEqual(["close"]);
	});

	it("says who steered the close, for its host's journal", () => {
		const one = session(true);
		one.pausing.act("close", "joel");
		expect(one.closedBy).toEqual([
			"Close from outside its window, steered by joel",
		]);

		const unsigned = session(true);
		unsigned.pausing.act("close");
		expect(unsigned.closedBy, "a steer with no writer says so").toEqual([
			"Close from outside its window, steered by a writer that didn't sign it",
		]);
	});
});

describe("carrying a session to another machine", () => {
	it("ends the run in progress, carries its work, then closes it", async () => {
		const busy = session(false);
		await busy.pausing.carry("penelope");
		expect(busy.did).toEqual(["abort", "carry to penelope", "close"]);

		const idle = session(true);
		await idle.pausing.carry("penelope");
		expect(idle.did).toEqual(["carry to penelope", "close"]);
	});

	it("says the carry and who steered it as it closes, for its host's journal", async () => {
		const one = session(true);
		await one.pausing.carry("penelope", "joel");
		expect(one.closedBy).toEqual([
			"a carry to penelope from outside its window, steered by joel",
		]);
	});

	it("ends any run that starts once its work is being carried", async () => {
		let carried = () => {};
		const one = session(
			true,
			() =>
				new Promise((done) => {
					carried = done;
				}),
		);

		const carrying = one.pausing.carry("penelope");
		one.pausing.started();
		carried();
		await carrying;

		expect(one.did).toEqual(["carry to penelope", "abort", "close"]);
		one.pausing.started();
		expect(one.did.at(-1), "and while pi winds down to close").toBe("abort");
	});

	it("stays open and says why when its work could not be carried", async () => {
		const one = session(true, async () => {
			throw new Error("the scratch folder can't be written");
		});

		await one.pausing.carry("penelope");

		expect(one.did).toEqual(["carry to penelope"]);
		expect(one.told.at(-1)).toContain("the scratch folder can't be written");
		one.pausing.started();
		expect(one.did, "and goes on working as it was").toHaveLength(1);
	});
});
