/**
 * What an ordered carry's close stops: background commands that only
 * wait, which claim no lease (23 November), named in a note carried
 * with the conversation; and a step that throws, which refuses it.
 */

import { describe, expect, it } from "vitest";
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
		expect(note !== undefined && isAutomatedText(note)).toBe(true);
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
		expect(isAutomatedText(one.noted[1] ?? "")).toBe(true);
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
			"but it couldn't close here: the session is stale. Each run here is stopped, so the two never both work; end it here once it starts there.",
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
			"This run is stopped: the session was carried to penelope and runs there, so end it here.",
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
