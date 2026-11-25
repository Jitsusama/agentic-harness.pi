/**
 * What an ordered carry's close stops: background commands that only
 * wait, which claim no lease (23 November), named in a note carried
 * with the conversation; and a step that throws, which refuses it.
 */

import { describe, expect, it, vi } from "vitest";
import {
	createOrderedCarrying,
	type OrderedCarryHost,
} from "../../../extensions/mesh-workflow/ordered-carry.ts";
import { isAutomatedText } from "../../../lib/internal/automated.ts";

/** Jobs as the job list names them, none judged by its whole command. */
const labelled = (...labels: string[]) => labels.map((label) => ({ label }));

const ORDER = {
	to: "penelope",
	why: "its camera work needs the Mac",
	by: "WCJQSG",
};

/** An idle session holding nothing, with what each test changes. */
function session(over: Partial<OrderedCarryHost> = {}) {
	const did: string[] = [];
	const refused: string[] = [];
	const noted: string[] = [];
	const ordering = createOrderedCarrying({
		idle: () => true,
		abort: () => did.push("abort"),
		holds: async () => undefined,
		hold: () => ({ release: () => undefined, carried: () => undefined }),
		carry: async (to) => {
			did.push(`carry to ${to}`);
		},
		refuse: async (why) => {
			refused.push(why);
		},
		tell: () => undefined,
		close: (by) => did.push(`close: ${by}`),
		carryOn: () => undefined,
		stopping: () => [],
		note: (text) => {
			did.push("note");
			noted.push(text);
		},
		...over,
	});
	return { ordering, did, refused, noted };
}

describe("the waits an ordered carry's close stops", () => {
	it("are named in a note carried with it, before its work is carried", async () => {
		const one = session({
			stopping: () =>
				labelled("while ! grep -q rc= log; do sleep 10; done", "sleep 600"),
		});

		await one.ordering.order(ORDER);

		expect(one.did.slice(0, 2)).toEqual(["note", "carry to penelope"]);
		const [note] = one.noted;
		expect(
			note !== undefined && isAutomatedText(note),
			`the note carried is said as automated: ${note}`,
		).toBe(true);
		expect(note).toContain(
			"stopped 2 background commands that only waited, as the session closed here:\n- while ! grep -q rc= log; do sleep 10; done\n- sleep 600\nThe session now runs on penelope: start again there any you still need, minding that one watching this machine's files or units finds them only here.",
		);
	});

	it("are named by their labels though cut short, when judged whole as waits", async () => {
		const one = session({
			stopping: () => [
				{
					label: "while ! grep -q rc= /tmp/pi-quest-QEST-20261025-85PKB2/ht...",
					waits: true,
				},
				{ label: "until test -f done; do ...", waits: true },
			],
		});

		await one.ordering.order(ORDER);

		expect(one.noted[0]).toContain(
			"stopped 2 background commands that only waited, as the session closed here:\n- while ! grep -q rc= /tmp/pi-quest-QEST-20261025-85PKB2/ht...\n- until test -f done; do ...\nThe session now runs",
		);
	});

	it("never name a fleet or a round, whatever its label reads as", async () => {
		const one = session({
			stopping: () => [
				{ label: "sleep 600", waits: false },
				{ label: "tail -f log" },
			],
		});

		await one.ordering.order(ORDER);

		expect(one.noted[0]).toContain(
			"stopped a background command that only waited, as the session closed here:\n- tail -f log\nThe session",
		);
	});

	it("never name a job that isn't read whole as a wait", async () => {
		const one = session({
			stopping: () =>
				labelled(
					"subagent fleet: three reviewers",
					"while ! grep -q rc= log; do sleep 10; nix bu...",
					"sleep 600",
				),
		});

		await one.ordering.order(ORDER);

		expect(one.noted).toHaveLength(1);
		expect(one.noted[0]).toContain(
			"stopped a background command that only waited, as the session closed here:\n- sleep 600\nThe session",
		);
	});

	it("are said to still run here when the carry then fails", async () => {
		const one = session({
			stopping: () => labelled("sleep 600"),
			carry: async () => {
				throw new Error("no quest is loaded");
			},
		});

		await one.ordering.order(ORDER);

		expect(one.noted).toHaveLength(2);
		expect(
			isAutomatedText(one.noted[1] ?? ""),
			`the second note is said as automated: ${one.noted[1]}`,
		).toBe(true);
		expect(one.noted[1]).toContain(
			"didn't go, so the background commands named as stopped still run here: sleep 600.",
		);
		expect(one.refused).toEqual([
			"its work couldn't be carried: no quest is loaded",
		]);
	});

	it("leave no note where the close stops nothing", async () => {
		const one = session();

		await one.ordering.order(ORDER);

		expect(one.noted).toEqual([]);
		expect(one.did).toEqual([
			"carry to penelope",
			"close: an ordered carry to penelope by WCJQSG, for its camera work needs the Mac",
		]);
	});
});

describe("an ordered carry a step of fails", () => {
	it("is refused, saying why, when telling what holds it throws", async () => {
		const one = session({
			holds: async () => {
				throw new Error("no editor to read");
			},
		});

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual([
			"it couldn't be looked at: no editor to read",
		]);
		expect(one.did).toEqual([]);
	});

	it("is refused, carrying nothing, when its note can't be written", async () => {
		const one = session({
			stopping: () => labelled("sleep 600"),
			note: () => {
				throw new Error("the session file is gone");
			},
		});

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual([
			"its work couldn't be carried: the session file is gone",
		]);
		expect(one.did).toEqual([]);
	});

	it("isn't refused once its work is carried, though closing throws", async () => {
		const told: string[] = [];
		const one = session({
			tell: (text) => told.push(text),
			close: () => {
				throw new Error("the session is stale");
			},
		});

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual([]);
		expect(one.did).toEqual(["carry to penelope"]);
		expect(told.at(-1)).toContain(
			"but it couldn't close here: the session is stale. Each run here is stopped, so the two never both work.",
		);

		await one.ordering.order(ORDER);

		expect(one.did).toEqual(["carry to penelope"]);
		expect(told.at(-1)).toContain("came once this session was carried");
	});

	it("says why each later run is stopped once its work is carried but it couldn't close", async () => {
		const told: string[] = [];
		const one = session({
			tell: (text) => told.push(text),
			close: () => {
				throw new Error("the session is stale");
			},
		});
		await one.ordering.order(ORDER);

		one.ordering.started();

		expect(one.did).toEqual(["carry to penelope", "abort"]);
		expect(told.at(-1)).toBe(
			"This run is stopped: the session was carried to penelope and runs there.",
		);
	});

	it("says why it stops each later run where a host's close fails after it was asked", async () => {
		const told: string[] = [];
		let failClose: ((error: unknown) => void) | undefined;
		let idle = true;
		const one = session({
			tell: (text) => told.push(text),
			idle: () => idle,
			close: (by, failed) => {
				one.did.push(`close: ${by}`);
				failClose = failed;
			},
		});
		await one.ordering.order(ORDER);

		failClose?.(new Error("the engine is gone"));
		idle = false;
		one.ordering.turnEnded();

		expect(told).toContain(
			"Carried to penelope, as WCJQSG ordered for its camera work needs the Mac, but it couldn't close here: the engine is gone. Each run here is stopped, so the two never both work.",
		);
		expect(one.did.at(-1)).toBe("abort");
		expect(told.at(-1), "a turn's end says why too").toBe(
			"This run is stopped: the session was carried to penelope and runs there.",
		);
	});

	it("names the waits its note called stopped as still running where it couldn't close", async () => {
		const told: string[] = [];
		const one = session({
			tell: (text) => told.push(text),
			stopping: () => labelled("sleep 600"),
			close: () => {
				throw new Error("the session is stale");
			},
		});

		await one.ordering.order(ORDER);

		expect(told.at(-1)).toMatch(
			/couldn't close here: the session is stale\..* The background commands its note named as stopped still run here, so stop them too: sleep 600\.$/,
		);
	});

	it("still closes once carried, though its screen has gone stale", async () => {
		const one = session({
			tell: () => {
				throw new Error("the screen is stale");
			},
		});

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual([]);
		expect(one.did).toEqual([
			"carry to penelope",
			expect.stringMatching(/^close: /),
		]);
	});

	it("is refused for its own reason, though its screen has gone stale", async () => {
		const one = session({
			holds: async () => "a build runs",
			tell: () => {
				throw new Error("the screen is stale");
			},
		});

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual(["a build runs"]);
		expect(one.did).toEqual([]);
	});

	it("is refused once, for its own reason, though the run it ended can't be taken up", async () => {
		const told: string[] = [];
		let started: () => void = () => undefined;
		const one = session({
			// A run starts while it waits, which it ends to go, then can't.
			holds: async (late) => {
				if (!late) return undefined;
				started();
				return "a build runs";
			},
			tell: (text) => told.push(text),
			carryOn: () => {
				throw new Error("the session is stale");
			},
		});
		started = () => one.ordering.started();

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual(["a build runs"]);
		expect(one.did).toEqual(["abort"]);
		expect(told.at(-1)).toContain(
			"The run it ended couldn't be taken up: the session is stale",
		);
	});

	it("takes the next order once refused", async () => {
		let fail = true;
		const one = session({
			carry: async () => {
				if (fail) throw new Error("no quest is loaded");
			},
		});
		await one.ordering.order(ORDER);
		fail = false;

		await one.ordering.order(ORDER);

		expect(one.refused).toEqual([
			"its work couldn't be carried: no quest is loaded",
		]);
		expect(one.did).toEqual([
			"close: an ordered carry to penelope by WCJQSG, for its camera work needs the Mac",
		]);
	});
});

describe("an ordered carry's close", () => {
	const UNCLOSED =
		"Carried to penelope, as WCJQSG ordered for its camera work needs the Mac, but it couldn't close here:";
	const STOPPED =
		"This run is stopped: the session was carried to penelope and runs there.";

	it("counts as failed once it hangs past its deadline, saying so once, and says why each later run is stopped", async () => {
		const told: string[] = [];
		const one = session({
			tell: (text) => told.push(text),
			// Asked, it never lands nor fails, as a host's close that hangs.
			close: (by) => one.did.push(`close: ${by}`),
			closeMs: 20,
		});
		await one.ordering.order(ORDER);

		await vi.waitFor(() =>
			expect(told.filter((line) => line.startsWith(UNCLOSED))).toEqual([
				`${UNCLOSED} it hadn't closed after 0.02 s. Each run here is stopped, so the two never both work.`,
			]),
		);
		one.ordering.started();
		one.ordering.started();

		expect(one.did.slice(-2)).toEqual(["abort", "abort"]);
		expect(told.slice(-2)).toEqual([STOPPED, STOPPED]);
		expect(
			told.filter((line) => line.startsWith(UNCLOSED)),
			"said once",
		).toHaveLength(1);
	});

	it("says once why a close that fails after its deadline failed, which the deadline couldn't", async () => {
		const told: string[] = [];
		let failClose: ((error: unknown) => void) | undefined;
		const one = session({
			tell: (text) => told.push(text),
			close: (_, failed) => {
				failClose = failed;
			},
			closeMs: 20,
		});
		await one.ordering.order(ORDER);
		await vi.waitFor(() =>
			expect(
				told.some((line) => line.startsWith(UNCLOSED)),
				`a line starts ${UNCLOSED}: ${JSON.stringify(told)}`,
			).toBe(true),
		);

		failClose?.(new Error("the engine is gone"));
		failClose?.(new Error("the engine is still gone"));

		expect(told.filter((line) => line.startsWith(UNCLOSED))).toEqual([
			`${UNCLOSED} it hadn't closed after 0.02 s. Each run here is stopped, so the two never both work.`,
			`${UNCLOSED} it failed after its deadline: the engine is gone. Each run here is stopped, so the two never both work.`,
		]);
	});

	it("says no late failure once a close that hung has landed", async () => {
		const told: string[] = [];
		let failClose: ((error: unknown) => void) | undefined;
		let land: (() => void) | undefined;
		const one = session({
			tell: (text) => told.push(text),
			close: (_, failed, closed) => {
				failClose = failed;
				land = closed;
			},
			closeMs: 20,
		});
		await one.ordering.order(ORDER);
		await vi.waitFor(() =>
			expect(
				told.some((line) => line.startsWith(UNCLOSED)),
				`a line starts ${UNCLOSED}: ${JSON.stringify(told)}`,
			).toBe(true),
		);

		land?.();
		failClose?.(new Error("the engine is gone"));

		expect(told.filter((line) => line.startsWith(UNCLOSED))).toHaveLength(1);
	});

	it("says a close that fails before its deadline failed once, however often it is told", async () => {
		const told: string[] = [];
		const one = session({
			tell: (text) => told.push(text),
			close: (_, failed) => {
				failed(new Error("the engine is gone"));
				failed(new Error("the engine is still gone"));
			},
			closeMs: 20,
		});
		await one.ordering.order(ORDER);

		// Past its deadline, as the clock it was given reads it.
		await new Promise((done) => setTimeout(done, 60));

		expect(told.filter((line) => line.startsWith(UNCLOSED))).toEqual([
			`${UNCLOSED} the engine is gone. Each run here is stopped, so the two never both work.`,
		]);
	});

	it("says a close that throws nothing of why in words", async () => {
		const kept: string[] = [];
		const one = session({
			journal: (text) => kept.push(text),
			close: () => {
				// As `new Error()` makes it, which the linter won't let be written.
				throw Object.assign(new Error("said"), { message: "" });
			},
		});

		await one.ordering.order(ORDER);

		expect(kept).toEqual([
			`${UNCLOSED} something was thrown that said nothing of why. Each run here is stopped, so the two never both work.`,
		]);
	});

	it("never counts as failed where it lands within its deadline", async () => {
		const told: string[] = [];
		const one = session({
			tell: (text) => told.push(text),
			close: (_, _failed, closed) => closed(),
			closeMs: 20,
		});
		await one.ordering.order(ORDER);

		// Past its deadline, as the clock it was given reads it.
		await new Promise((done) => setTimeout(done, 60));

		expect(told.filter((line) => line.startsWith(UNCLOSED))).toEqual([]);
	});

	it("keeps a close that failed in the host's journal, for a conversation nobody watches", async () => {
		const kept: string[] = [];
		const one = session({
			journal: (text) => kept.push(text),
			close: () => {
				throw new Error("the engine is gone");
			},
		});

		await one.ordering.order(ORDER);

		expect(kept).toEqual([
			`${UNCLOSED} the engine is gone. Each run here is stopped, so the two never both work.`,
		]);
	});

	it("still says a close that failed on screen where the journal can't be written", async () => {
		const told: string[] = [];
		const one = session({
			tell: (text) => told.push(text),
			journal: () => {
				throw new Error("the journal is gone");
			},
			close: () => {
				throw new Error("the engine is gone");
			},
		});

		await one.ordering.order(ORDER);

		expect(told.filter((line) => line.startsWith(UNCLOSED))).toEqual([
			`${UNCLOSED} the engine is gone. Each run here is stopped, so the two never both work.`,
		]);
		expect(one.refused, "a journal that throws refuses nothing").toEqual([]);

		one.ordering.started();

		expect(
			told.at(-1),
			"nor keeps a later run from being stopped and told why",
		).toBe(
			"This run is stopped: the session was carried to penelope and runs there.",
		);
	});

	it("says a close that lands past its deadline closed after all, on screen and in the journal", async () => {
		const told: string[] = [];
		const kept: string[] = [];
		let land: (() => void) | undefined;
		const one = session({
			tell: (text) => told.push(text),
			journal: (text) => kept.push(text),
			close: (_, _failed, closed) => {
				land = closed;
			},
			closeMs: 20,
		});
		await one.ordering.order(ORDER);
		await vi.waitFor(() =>
			expect(
				kept.some((line) => line.startsWith(UNCLOSED)),
				`a line starts ${UNCLOSED}: ${JSON.stringify(kept)}`,
			).toBe(true),
		);

		land?.();
		land?.();

		const after =
			"Carried to penelope, as WCJQSG ordered for its camera work needs the Mac, and it closed here after all.";
		expect(
			told.filter((line) => line === after),
			"once",
		).toHaveLength(1);
		expect(kept.at(-1)).toBe(after);
	});

	it("says a close told failed before its deadline, then landing, closed after all, once", async () => {
		const told: string[] = [];
		const one = session({
			tell: (text) => told.push(text),
			close: (_, failed, closed) => {
				failed(new Error("the engine stalled"));
				closed();
				closed();
			},
		});

		await one.ordering.order(ORDER);

		const after =
			"Carried to penelope, as WCJQSG ordered for its camera work needs the Mac, and it closed here after all.";
		expect(told.filter((line) => line.startsWith(UNCLOSED))).toEqual([
			`${UNCLOSED} the engine stalled. Each run here is stopped, so the two never both work.`,
		]);
		expect(
			told.filter((line) => line === after),
			"once",
		).toHaveLength(1);
	});

	it("says nothing more where it lands in time, however late it is told again", async () => {
		const kept: string[] = [];
		let land: (() => void) | undefined;
		const one = session({
			journal: (text) => kept.push(text),
			close: (_, _failed, closed) => {
				land = closed;
				closed();
			},
			closeMs: 20,
		});
		await one.ordering.order(ORDER);

		// Past its deadline, as the clock it was given reads it.
		await new Promise((done) => setTimeout(done, 60));
		land?.();

		expect(kept).toEqual([]);
	});
});
