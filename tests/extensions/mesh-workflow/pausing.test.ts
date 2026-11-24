/**
 * Pause, Resume, Stop, Park and Close from outside a session's window.
 */
import { describe, expect, it, vi } from "vitest";
import {
	CLOCKS_DIFFER_MS,
	createPausing,
	NOTHING_WAKES,
	type Pausing,
	type PausingHost,
} from "../../../extensions/mesh-workflow/pausing.ts";

interface Session {
	idle: boolean;
	/** The time its pausing reads, in ms; it starts at 0. */
	time: number;
	readonly pausing: Pausing;
	readonly did: string[];
	readonly told: string[];
	/** What it said in a host's journal. */
	readonly journal: string[];
	/** Who each close said asked for it. */
	readonly closedBy: string[];
}

function session(
	idle: boolean,
	carry: (to: string) => Promise<void> = async () => {},
	closing: Pick<PausingHost, "closeMs"> & {
		/** What the host's close then does, given its failed and closed. */
		readonly afterwards?: (
			failed: (error: unknown) => void,
			closed: () => void,
		) => void;
		/** Why its park watch won't park it, or nothing where it parks. */
		readonly park?: () => string | undefined;
		/** When it started here, by its clock; 0 unless given. */
		readonly startsAt?: number;
	} = {},
): Session {
	const did: string[] = [];
	const told: string[] = [];
	const journal: string[] = [];
	const closedBy: string[] = [];
	let paused = false;
	const state = { idle, time: closing.startsAt ?? 0 };
	// The machine a carry under way takes its work to, as the carry's
	// hold says it from when it is asked until it settles.
	let underWay: string | undefined;
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
			journal: (text) => journal.push(text),
			close: (by, failed, closed) => {
				did.push("close");
				closedBy.push(by);
				if (closing.afterwards && failed && closed)
					closing.afterwards(failed, closed);
				else closed?.();
			},
			...(closing.closeMs === undefined ? {} : { closeMs: closing.closeMs }),
			carry: async (to) => {
				did.push(`carry to ${to}`);
				underWay = to;
				try {
					await carry(to);
				} finally {
					underWay = undefined;
				}
			},
			carryUnderWay: () => underWay,
			park: () => {
				did.push("park");
				return closing.park?.();
			},
		}),
		did,
		told,
		journal,
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
	it("drops a Stop written before the run in progress began, saying so", () => {
		const woken = session(true);
		woken.time = 20_000;
		woken.idle = false;
		woken.pausing.started();

		woken.pausing.act("stop", "joel", written(15_000));

		expect(woken.did, "the run the wake began goes on").toEqual([]);
		expect(woken.told.at(-1)).toContain("dropped");
		expect(woken.told.at(-1)).toContain(written(15_000));
		expect(woken.told.at(-1)).toContain("the run in progress began");
		expect(woken.journal, "and in a host's journal").toEqual(woken.told);
	});

	it("drops a Pause written before the person last talked to it, saying so", () => {
		// A talk ends a pause, so one pressed before the words that woke
		// the session, and read after them, is already over.
		const woken = session(true);
		woken.time = 20_000;
		woken.pausing.talked();
		woken.idle = false;
		woken.pausing.started();

		woken.pausing.act("pause", "joel", written(15_000));
		woken.pausing.turnEnded();

		expect(
			woken.pausing.paused,
			"a pause from before the talk is dropped",
		).toBe(false);
		expect(woken.did, "the run the talk began goes on").toEqual([]);
		expect(woken.told.at(-1)).toContain("the person last talked");
	});

	it("reads a talk by the time its steer says, so a later Pause still holds", () => {
		const one = session(true);
		one.time = 30_000;
		one.pausing.talked(written(10_000));

		one.pausing.act("pause", "joel", written(20_000));

		expect(one.pausing.paused, "the pause came after the talk").toBe(true);
	});

	it("keeps a Pause left for a parked session through its wake", () => {
		// A pause does nothing to a session that isn't running, so it waits
		// for its next start, and holds whatever woke it but the person.
		const woken = session(true);
		woken.time = 20_000;
		woken.pausing.act("pause", "joel", written(5_000));
		woken.idle = false;
		woken.pausing.started();

		expect(woken.pausing.paused, "the pause waited for its start").toBe(true);
		expect(woken.did, "the run a peer's wake began is ended").toEqual([
			"abort",
		]);
	});

	it("still stops the run it was written during", () => {
		const one = session(true);
		one.time = 20_000;
		one.idle = false;
		one.pausing.started();

		one.pausing.act("stop", "joel", written(25_000));

		expect(one.did).toEqual(["abort"]);
	});

	it("still stops a run begun as it was written, within what clocks differ by", () => {
		for (const early of [0, CLOCKS_DIFFER_MS]) {
			const one = session(true);
			one.time = 20_000;
			one.idle = false;
			one.pausing.started();

			one.pausing.act("stop", "joel", written(20_000 - early));

			expect(one.did, `written ${early} ms before`).toEqual(["abort"]);
		}
	});

	it("stops a run it saw no start of, as a reload made mid-run sees", () => {
		const reloaded = session(false);
		reloaded.time = 20_000;

		reloaded.pausing.act("stop", "joel", written(5_000));

		expect(reloaded.did).toEqual(["abort"]);
	});

	it("still pauses after a run it was written during has ended", () => {
		const one = session(true);
		one.time = 20_000;
		one.idle = false;
		one.pausing.started();
		one.idle = true;

		one.pausing.act("pause", "joel", written(25_000));
		one.pausing.started();

		expect(one.pausing.paused, "the pause holds for later runs").toBe(true);
		expect(one.did, "the next run is ended as it starts").toEqual(["abort"]);
	});

	it("acts on a steer that says no time, or one it can't read, as written now", () => {
		for (const at of [undefined, "not a time"]) {
			const one = session(true);
			one.time = 20_000;
			one.idle = false;
			one.pausing.started();

			one.pausing.act("stop", "joel", at);

			expect(one.did, String(at)).toEqual(["abort"]);
		}
	});

	it("never drops a Close or a Resume for its time", () => {
		const closing = session(true);
		closing.time = 20_000;
		closing.pausing.started();
		closing.pausing.act("close", "joel", written(5_000));
		expect(closing.did).toEqual(["close"]);

		const resuming = session(true);
		resuming.pausing.act("pause");
		resuming.time = 20_000;
		resuming.pausing.started();
		resuming.pausing.act("resume", "joel", written(5_000));
		expect(resuming.pausing.paused, "the resume still lands").toBe(false);
		expect(resuming.did.at(-1)).toBe("carry on");
	});
});

// Joel, 24 November, by 42P0R4 [f00e0dec]: hold a cell parked from the
// launcher, so its process ends and frees memory, then wake it on a
// message, a key or a window.
describe("parking a session from outside its window", () => {
	it("parks an idle one at once, saying who steered it in its host's journal", () => {
		const idle = session(true);

		idle.pausing.act("park", "joel");

		expect(idle.did).toEqual(["park"]);
		expect(idle.journal).toEqual([
			"Parked from outside its window, steered by joel.",
		]);
	});

	it("lets the turn under way finish, ends the run there, and parks once it settles", () => {
		const busy = session(false);

		busy.pausing.act("park", "joel");
		expect(busy.did, "nothing parks mid-turn").toEqual([]);
		expect(busy.told.at(-1)).toContain("after the current turn");

		busy.pausing.turnEnded();
		expect(busy.did).toEqual(["abort"]);

		busy.idle = true;
		busy.pausing.settled();
		busy.pausing.settled();
		expect(busy.did, "asked once, as it settles").toEqual(["abort", "park"]);
		expect(busy.pausing.paused, "a park is no pause").toBe(false);
	});

	it("stays awake and says why where its park watch refuses, on screen and in the journal", () => {
		const held = session(true, undefined, { park: () => "a prompt is open" });

		held.pausing.act("park", "joel");

		const line =
			"A Park from outside its window, steered by joel, was refused: a prompt is open.";
		expect(held.told).toEqual([line]);
		expect(held.journal).toEqual([line]);
	});

	it("says why where nothing would wake it, in the words the host gives", () => {
		const unheld = session(true, undefined, { park: () => NOTHING_WAKES });

		unheld.pausing.act("park", "joel");

		expect(unheld.told.at(-1)).toContain("parking it would only end it");
	});

	it("is called off by a talk, Resume, Stop, Pause or Close before it lands", () => {
		const after: Record<string, (one: Session) => void> = {
			talk: (one) => one.pausing.talked(),
			resume: (one) => one.pausing.act("resume"),
			stop: (one) => one.pausing.act("stop"),
			pause: (one) => one.pausing.act("pause"),
			close: (one) => one.pausing.act("close"),
		};
		for (const [what, then] of Object.entries(after)) {
			const busy = session(false);
			busy.pausing.act("park", "joel");
			then(busy);
			busy.idle = true;
			busy.pausing.settled();

			expect(busy.did, what).not.toContain("park");
			expect(busy.told.join("\n"), what).toContain("called off");
		}
	});

	it("is called off by a Carry before it lands", async () => {
		const busy = session(false);
		busy.pausing.act("park", "joel");

		await busy.pausing.carry("osprey", "joel");
		busy.idle = true;
		busy.pausing.settled();

		expect(busy.did).not.toContain("park");
		expect(busy.told.join("\n")).toContain("a Carry came after it");
	});

	// A Park doesn't wake a session already parked, so one left for it is
	// read as a message wakes it, and would park it again before it read
	// the message.
	it("drops a Park written before it last started here, saying so", () => {
		const woken = session(true, undefined, { startsAt: 20_000 });

		woken.pausing.act("park", "joel", written(5_000));

		expect(woken.did, "the wake's message is read").toEqual([]);
		expect(woken.told.at(-1)).toContain("this session last started");
		expect(woken.journal).toEqual(woken.told);
	});

	it("parks for one written as it started, within what clocks differ by, or saying no time", () => {
		for (const at of [written(20_000 - CLOCKS_DIFFER_MS), undefined]) {
			const one = session(true, undefined, { startsAt: 20_000 });

			one.pausing.act("park", "joel", at);

			expect(one.did, String(at)).toEqual(["park"]);
		}
	});

	it("drops a Park written before the person last talked to it", () => {
		const one = session(true);
		one.time = 30_000;
		one.pausing.talked(written(20_000));

		one.pausing.act("park", "joel", written(10_000));

		expect(one.did).toEqual([]);
		expect(one.told.at(-1)).toContain("the person last talked");
	});

	it("asks nothing as a run settles where no Park waits", () => {
		const one = session(true);

		one.pausing.settled();

		expect(one.did).toEqual([]);
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

	// A second press while the first carry bundles once turned its run
	// guard off and said the session stays open (PV3TE0's F1 and F9).
	it("leaves a second Carry to the one under way, which still ends every run", async () => {
		let carried = () => {};
		const one = session(
			true,
			() =>
				new Promise((done) => {
					carried = done;
				}),
		);

		const first = one.pausing.carry("penelope");
		await one.pausing.carry("equilibrius", "launcher");
		const left =
			"A Carry to equilibrius from outside its window, steered by launcher, was left to the carry to penelope already under way, which closes this session if it carries; if that one is refused, Carry again.";
		expect(one.did, "carries once").toEqual(["carry to penelope"]);
		expect(one.told.at(-1)).toBe(left);
		expect(one.journal, "kept for a window nobody watches").toEqual([left]);
		one.pausing.started();
		expect(one.did.at(-1), "a run started mid-carry still ends").toBe("abort");

		carried();
		await first;
		expect(one.did).toEqual(["carry to penelope", "abort", "close"]);
	});
});

describe("the person's Carry from outside the window, once carried", () => {
	const UNCLOSED =
		"Carried to penelope, but it couldn't close here: the engine is gone. Each run here is stopped, so the two never both work.";
	const STOPPED =
		"This run is stopped: the session was carried to penelope and runs there.";

	it("says once, in its journal too, where its close fails late, and why each run after it is stopped", async () => {
		let failClose: ((error: unknown) => void) | undefined;
		const one = session(true, async () => {}, {
			afterwards: (failed) => {
				failClose = failed;
			},
		});
		await one.pausing.carry("penelope");

		failClose?.(new Error("the engine is gone"));
		failClose?.(new Error("the engine is gone"));
		one.pausing.started();

		expect(one.told.filter((line) => line === UNCLOSED)).toHaveLength(1);
		expect(one.journal, "a window nobody watches is told too").toContain(
			UNCLOSED,
		);
		expect(one.did.at(-1)).toBe("abort");
		expect(one.told.at(-1)).toBe(STOPPED);
	});

	it("counts a close that hangs past its deadline as failed", async () => {
		const one = session(true, async () => {}, {
			afterwards: () => undefined,
			closeMs: 20,
		});
		await one.pausing.carry("penelope");

		await vi.waitFor(() =>
			expect(one.told).toContain(
				"Carried to penelope, but it couldn't close here: it hadn't closed after 0.02 s. Each run here is stopped, so the two never both work.",
			),
		);
	});

	it("says a close that lands past its deadline closed after all, once, in its journal too", async () => {
		let land: (() => void) | undefined;
		const one = session(true, async () => {}, {
			afterwards: (_failed, closed) => {
				land = closed;
			},
			closeMs: 20,
		});
		await one.pausing.carry("penelope");
		await vi.waitFor(() =>
			expect(one.journal.some((line) => line.includes("hadn't closed"))).toBe(
				true,
			),
		);

		land?.();
		land?.();

		const after = "Carried to penelope, and it closed here after all.";
		expect(one.told.filter((line) => line === after)).toHaveLength(1);
		expect(one.journal.at(-1)).toBe(after);
	});

	it("never counts a close that landed as failed, once its deadline has passed", async () => {
		const one = session(true, async () => {}, { closeMs: 20 });
		await one.pausing.carry("penelope");

		// Past its deadline, as the clock it was given reads it.
		await new Promise((done) => setTimeout(done, 60));
		one.pausing.started();

		expect(one.journal).toEqual([]);
		expect(one.told.filter((line) => line.includes("couldn't close"))).toEqual(
			[],
		);
		expect(one.told.at(-1), "nor says a run stopped for it").toBe(
			"Carried to penelope; closing.",
		);
	});

	it("says nothing more where its close lands", async () => {
		const one = session(true);
		await one.pausing.carry("penelope");

		one.pausing.started();

		expect(one.told.at(-1)).toBe("Carried to penelope; closing.");
		expect(one.did.at(-1), "a run is still ended while it closes").toBe(
			"abort",
		);
	});
});
