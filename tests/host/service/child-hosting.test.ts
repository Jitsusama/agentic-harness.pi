/** A host's children put together: routes, supervisor and policy, as the backend and its stop use them. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type HostedChildren,
	hostChildren,
	WAKES_A_DAY,
	WAKES_COUNTED_OVER_MS,
	WOKEN_AGAIN_AFTER_MS,
} from "../../../host/service/child-hosting.ts";
import type { ChildPolicy } from "../../../host/service/child-policy.ts";
import { BEGIN_TOO_LATE } from "../../../host/service/child-requests.ts";
import type { KeptRoster } from "../../../host/service/child-supervisor.ts";
import type { RosterEntry } from "../../../lib/core/session/roster.ts";
import {
	conversationIn,
	entryIn,
	type FakeUnits,
	fakeUnits,
} from "./support/fake-children.ts";

const key = "work-background";
const a = "a0000000-0000-4000-8000-000000000001";
const b = "b0000000-0000-4000-8000-000000000002";

let folder: string;
let held: RosterEntry[];
let units: FakeUnits;
let reported: unknown[];
let said: string[];
let told: [string, string][];
let rested: RosterEntry[];
let givenUp: RosterEntry[];
let resting: boolean;
// Why the engine can't rest one given up, or nothing once it rests.
let givingUp: string | undefined;
// Each conversation woken, in order, and how its wake goes.
let woken: string[];
// Each rest and wake, in the order they came.
let order: string[];
let waking: () => Promise<void>;
let clock: number;
let policy: ChildPolicy & { moving: Set<string>; opening: boolean };
let children: HostedChildren;

/** A roster in memory, as much of one as the supervisor keeps. */
function roster(): KeptRoster {
	return {
		entries: () => [...held],
		async hold(entry) {
			held = [...held, entry];
		},
		async replace(previousId, entry) {
			held = held.map((one) => (one.sessionId === previousId ? entry : one));
		},
		async drop(sessionId) {
			held = held.filter((one) => one.sessionId !== sessionId);
		},
	};
}

beforeEach(async () => {
	// Short, since a socket's path may run to no more than 107 bytes.
	folder = await mkdtemp(join(tmpdir(), "ch-"));
	held = [entryIn(folder, a)];
	units = fakeUnits(folder, key, (error) => reported.push(error));
	reported = [];
	said = [];
	told = [];
	rested = [];
	givenUp = [];
	resting = true;
	givingUp = undefined;
	woken = [];
	order = [];
	waking = async () => undefined;
	clock = 0;
	const moving = new Set<string>();
	policy = {
		moving,
		opening: false,
		moves: (sessionId) => moving.has(sessionId),
		opens: () => policy.opening,
		close: vi.fn(),
	};
	children = hosting(true);
});

/** The hosting, with the engine resting one given up, or not able to. */
function hosting(restsGivenUp: boolean): HostedChildren {
	return hostChildren({
		key,
		folder,
		units,
		policy,
		roster: roster(),
		restsParked(entry) {
			rested.push(entry);
			order.push(`rested ${entry.sessionId}`);
			return resting;
		},
		...(restsGivenUp
			? {
					restGivenUp(entry: RosterEntry) {
						givenUp.push(entry);
						return givingUp;
					},
				}
			: {}),
		report: (error) => reported.push(error),
		say: (line) => said.push(line),
		became: (previousId, nextId) => told.push([previousId, nextId]),
		wake(sessionId) {
			woken.push(sessionId);
			order.push(`woken ${sessionId}`);
			return waking();
		},
		now: () => clock,
		timings: {
			listensWithinMs: 5_000,
			answersWithinMs: 500,
			exitsWithinMs: 500,
		},
	});
}

afterEach(async () => {
	children.close();
	for (const child of units.children.values()) await child?.exit();
	await rm(folder, { recursive: true, force: true });
});

describe("a host's children", () => {
	it("moves what the policy says, as it says it now", () => {
		expect(children.backend.moves(a), "nothing named, nothing moves").toBe(
			false,
		);
		policy.moving.add(a);
		policy.opening = true;
		expect(children.backend.moves(a), "one named moves").toBe(true);
		expect(children.backend.opens(), "opens move when all do").toBe(true);
	});

	it("lists one a child runs as the child lists it, and none once it ends", async () => {
		const shown = await children.backend.resume(held[0] as RosterEntry, false);
		expect(children.backend.running(a)).toEqual(shown);
		expect(children.routes.routeOf(a), "routed to its child").toBeDefined();
		await units.childOf(a).end("closed");
		await vi.waitFor(() =>
			expect(children.backend.running(a), "no child runs it").toBeUndefined(),
		);
	});

	it("rests one whose child ended parked, so its wake is watched again", async () => {
		await children.backend.resume(held[0] as RosterEntry, true);
		await units.childOf(a).end("parked");
		await vi.waitFor(() =>
			expect(rested.map(({ sessionId }) => sessionId)).toEqual([a]),
		);
		expect(
			held.map(({ sessionId }) => sessionId),
			"still held",
		).toEqual([a]);
	});

	it("rests one whose child failed, since it is still held", async () => {
		await children.backend.resume(held[0] as RosterEntry, false);
		await units.childOf(a).exit();
		await vi.waitFor(() =>
			expect(rested.map(({ sessionId }) => sessionId)).toEqual([a]),
		);
	});

	describe("one whose child failed mid-turn", () => {
		/** Resume `a` in a child that says it is busy, as one mid-turn does. */
		async function busy() {
			await children.backend.resume(entryIn(folder, a), true);
			units.childOf(a).say({
				type: "state",
				conversation: { ...conversationIn(folder, a), state: "busy" },
			});
			await vi.waitFor(() =>
				expect(children.backend.running(a)?.state).toBe("busy"),
			);
		}

		// Item 7: rested, a turn its child was killed in waited for a window or
		// a message, though a host's own restart carries every such turn on.
		it("wakes it at once, once rested", async () => {
			await busy();
			await units.childOf(a).exit();

			await vi.waitFor(() => expect(woken, "woken").toEqual([a]));
			expect(order, "rested first, so its wake stays watched").toEqual([
				`rested ${a}`,
				`woken ${a}`,
			]);
			expect(said).toContain(
				`${a}: its child failed mid-turn, so it is woken to carry the turn on`,
			);
		});

		it("leaves one idle as its child failed resting", async () => {
			await children.backend.resume(entryIn(folder, a), true);
			await units.childOf(a).exit();

			await vi.waitFor(() => expect(rested).toHaveLength(1));
			expect(woken, "nothing left unanswered").toEqual([]);
		});

		it("leaves one resting whose child went idle again before it failed", async () => {
			await busy();
			units.childOf(a).say({
				type: "state",
				conversation: { ...conversationIn(folder, a), state: "idle" },
			});
			await vi.waitFor(() =>
				expect(children.backend.running(a)?.state).toBe("idle"),
			);
			await units.childOf(a).exit();

			await vi.waitFor(() => expect(rested).toHaveLength(1));
			expect(woken, "its last state decides, and it had answered").toEqual([]);
		});

		it("rests it once it was woken so as often as a day allows, however far apart", async () => {
			for (const wake of Array.from({ length: WAKES_A_DAY }, (_, n) => n)) {
				clock = wake * WOKEN_AGAIN_AFTER_MS;
				await busy();
				await units.childOf(a).exit();
				await vi.waitFor(() => expect(woken).toHaveLength(wake + 1));
			}

			clock = WAKES_A_DAY * WOKEN_AGAIN_AFTER_MS;
			await busy();
			await units.childOf(a).exit();
			await vi.waitFor(() =>
				expect(said).toContain(
					`${a}: its child failed mid-turn after ${WAKES_A_DAY} wakes for that in a day, so it rests until it is asked for`,
				),
			);
			expect(woken, "not woken past the day's count").toHaveLength(WAKES_A_DAY);

			clock = WAKES_COUNTED_OVER_MS;
			await busy();
			await units.childOf(a).exit();
			await vi.waitFor(() =>
				expect(woken, "woken once its first wake is a day old").toHaveLength(
					WAKES_A_DAY + 1,
				),
			);
		});

		it("leaves one whose busy child said it parked resting", async () => {
			await busy();
			await units.childOf(a).end("parked");

			await vi.waitFor(() => expect(rested).toHaveLength(1));
			expect(woken, "a park keeps its turn for the next wake").toEqual([]);
		});

		it("rests it when it fails so again within the spacing of its last wake, and wakes it past it", async () => {
			await busy();
			await units.childOf(a).exit();
			await vi.waitFor(() => expect(woken).toEqual([a]));

			clock += WOKEN_AGAIN_AFTER_MS - 1;
			await busy();
			await units.childOf(a).exit();
			await vi.waitFor(() =>
				expect(said).toContain(
					`${a}: its child failed mid-turn again within 10 minutes of its last wake, so it rests until it is asked for`,
				),
			);
			expect(woken, "not woken a second time").toEqual([a]);

			clock += 1;
			await busy();
			await units.childOf(a).exit();
			await vi.waitFor(() =>
				expect(woken, "woken once the spacing has passed").toEqual([a, a]),
			);
		});

		it("leaves one whose busy child died as its close was asked resting", async () => {
			// The fake takes a close and answers none, as a child stuck mid-turn
			// does.
			await busy();
			const closing = children.backend.ask(a, {
				v: 1,
				id: "c",
				op: "close",
				sessionId: a,
			});
			const refused = closing.then(
				() => "answered",
				() => "refused",
			);
			await vi.waitFor(() =>
				expect(units.childOf(a).asked.map((one) => one.op)).toContain("close"),
			);
			await units.childOf(a).exit();

			await vi.waitFor(() =>
				expect(said).toContain(
					`${a}: its child failed mid-turn as it was asked to end, so it rests until it is asked for`,
				),
			);
			expect(await refused, "the close failed with its child").toBe("refused");
			expect(woken, "the close it was asked isn't undone").toEqual([]);
		});

		it("wakes one whose child refused its close and then died mid-turn", async () => {
			units.next = { refusesAsks: true };
			await busy();
			await expect(
				children.backend.ask(a, { v: 1, id: "c", op: "close", sessionId: a }),
				"refused by a child that lives on",
			).rejects.toThrow("refused");
			await units.childOf(a).exit();

			await vi.waitFor(() =>
				expect(woken, "its own death, not the close's").toEqual([a]),
			);
		});

		it("says a wake that didn't land, rather than reporting it", async () => {
			waking = () => Promise.reject(new Error("the host is stopping"));
			await busy();
			await units.childOf(a).exit();

			await vi.waitFor(() =>
				expect(said).toContain(
					`${a}: its wake after its child failed mid-turn didn't land: the host is stopping`,
				),
			);
			expect(reported).toEqual([]);
		});
	});

	// F167: a bounded resume, as a start's, that gives its child up before
	// its first answer ends no watch, so no ending rests it; left unrested,
	// a message written to its wake file would wake nothing until a window
	// asked for it. restsParked would decline one that never parked, so it
	// rests as given up, which writes the marker a park would.
	it("rests one whose bounded resume gave its child up as given up, since it is still held", async () => {
		units.next = { silent: true };

		await expect(
			children.backend.resume(entryIn(folder, a), false, true),
		).rejects.toThrow("as children.json says");

		expect(
			held.map(({ sessionId }) => sessionId),
			"still held",
		).toEqual([a]);
		await vi.waitFor(() =>
			expect(
				givenUp.map(({ sessionId }) => sessionId),
				"its wake watched again",
			).toEqual([a]),
		);
		expect(rested, "not asked whether it parked").toEqual([]);
		expect(
			said.filter((line) => line.includes("nothing watches its wake")),
			"rested, so nothing is said",
		).toEqual([]);
	});

	// F28, F31: one the engine can't rest is said, with the engine's why.
	it("says one given up that the engine can't rest, and why", async () => {
		units.next = { silent: true };
		givingUp = "this host runs it now";

		await expect(
			children.backend.resume(entryIn(folder, a), false, true),
		).rejects.toThrow("as children.json says");

		await vi.waitFor(() =>
			expect(said).toContain(
				`${a}: its child was given up, and nothing watches its wake until it is asked for, as this host runs it now`,
			),
		);
	});

	// F36: the one fallback, for an engine with no rest for one given up.
	it("says one given up that an engine with no rest for it can't rest", async () => {
		children.close();
		children = hosting(false);
		units.next = { silent: true };

		await expect(
			children.backend.resume(entryIn(folder, a), false, true),
		).rejects.toThrow("as children.json says");

		await vi.waitFor(() =>
			expect(said).toContain(
				`${a}: its child was given up, and nothing watches its wake until it is asked for, as this engine rests none given up`,
			),
		);
	});

	// F26: a window's attach may wake one nothing watches, so a wake's
	// give-up is said too; the engine keeps a watch that stands (F23).
	it("rests one whose wake gave its child up as given up", async () => {
		units.next = { silent: true };

		await expect(
			children.backend.resume(entryIn(folder, a), true),
		).rejects.toThrow("as children.json says");
		await vi.waitFor(() =>
			expect(units.stopped, "its child stopped").toHaveLength(1),
		);

		await vi.waitFor(() =>
			expect(
				givenUp.map(({ sessionId }) => sessionId),
				"rested as given up",
			).toEqual([a]),
		);
		expect(rested, "not asked whether it parked").toEqual([]);
		expect(
			held.map(({ sessionId }) => sessionId),
			"still held",
		).toEqual([a]);
	}, 15_000);

	it("rests nothing as given up for a resume its child takes, nor for one whose child ended", async () => {
		await children.backend.resume(entryIn(folder, a), false);
		expect(givenUp, "an ordinary resume writes no marker").toEqual([]);
		await units.childOf(a).end("parked");
		await vi.waitFor(() =>
			expect(rested.map(({ sessionId }) => sessionId)).toEqual([a]),
		);
		expect(givenUp, "a park writes its own marker").toEqual([]);
	});

	it("lets a child start still waiting go at once as it closes", async () => {
		const resuming = children.backend.resume(held[0] as RosterEntry, false);
		await vi.waitFor(() => expect(units.started).toHaveLength(1));
		children.close();

		await expect(resuming).rejects.toThrow();
		expect(rested, "left to the next host, not rested").toEqual([]);
		expect(givenUp, "nor rested as given up").toEqual([]);
		const [unit] = units.started;
		expect(
			units.children.get(unit as string),
			"failed before its child listened",
		).toBeUndefined();
		expect(units.stopped, "its child is left to run").toEqual([]);
		// It listens later, for the next host; end it before the folder goes.
		await vi.waitFor(() =>
			expect(units.children.get(unit as string)).toBeDefined(),
		);
		await units.children.get(unit as string)?.exit();
	});

	it("says the policy moved one whose child didn't start", async () => {
		units.next = { diesBeforeListening: true };

		await expect(
			children.backend.resume(held[0] as RosterEntry, false),
		).rejects.toThrow("as children.json says");
	});

	it("says once the child that ran one has gone, and not while its unit runs on", async () => {
		await children.backend.resume(held[0] as RosterEntry, false);
		const [unit] = units.started;
		// Its socket closes, but systemd says its unit still runs.
		let lingering = true;
		const gone = units.gone;
		units.gone = async (named) => !lingering && gone(named);
		await units.childOf(a).exit();
		await vi.waitFor(() => expect(rested).toHaveLength(1));

		await expect(children.backend.left(a)).rejects.toThrow(
			`${a} still runs in ${unit}`,
		);

		expect(units.forgotten, "its slot still held").not.toContain(unit);

		lingering = false;
		await children.backend.left(a);
		expect(units.forgotten, "freed by left").toContain(unit);
	});

	it("says one whose child failed before its first answer has left only once its unit has gone", async () => {
		units.next = { silent: true };
		let lingering = true;
		const gone = units.gone;
		units.gone = async (named) => !lingering && gone(named);

		await expect(
			children.backend.resume(held[0] as RosterEntry, false),
		).rejects.toThrow();
		const [unit] = units.started;

		await expect(children.backend.left(a)).rejects.toThrow(
			`${a} still runs in ${unit}`,
		);

		lingering = false;
		await children.backend.left(a);
		expect(units.forgotten, "its slot let go").toContain(unit);
	}, 15_000);

	it("tells on what a child's conversation became, once the roster holds it", async () => {
		await children.backend.resume(held[0] as RosterEntry, false);

		units.childOf(a).say({
			type: "became",
			previousId: a,
			conversation: conversationIn(folder, b),
			entry: entryIn(folder, b),
		});

		await vi.waitFor(() => expect(told).toEqual([[a, b]]));
		expect(
			held.map(({ sessionId }) => sessionId),
			"held in its place",
		).toEqual([b]);
	});

	// 23 November (ff6ecdd4): the backend's census can use up a begin's
	// time, which runs from when the host took the request.
	it("counts a begin's time from when the backend took it", async () => {
		const reply = await children.backend.begin(
			{ v: 1, id: "open-1", op: "open", cwd: folder, attended: false },
			Date.now() - 200_000,
		);

		expect(reply).toMatchObject({ ok: false, error: { code: BEGIN_TOO_LATE } });
		expect(units.started, "no child started").toEqual([]);
	});

	it("refuses to ask a child of one no child runs", async () => {
		await expect(
			children.backend.ask(a, { v: 1, id: "x", op: "abort", sessionId: a }),
		).rejects.toThrow("not hosted");
	});

	it("rests none that closed, which no longer is held", async () => {
		await children.backend.resume(held[0] as RosterEntry, false);
		await units.childOf(a).end("closed");
		await vi.waitFor(() => expect(held, "no longer held").toEqual([]));
		expect(rested, "nothing rested").toEqual([]);
	});

	// 23 November: two children ended parked that restsParked declined,
	// and nothing watched a hub's wake for 19 minutes.
	it("rests one whose park the engine won't take as given up, so its wake is watched", async () => {
		resting = false;
		await children.backend.resume(held[0] as RosterEntry, false);
		await units.childOf(a).end("parked");
		await vi.waitFor(() =>
			expect(
				givenUp.map(({ sessionId }) => sessionId),
				"rested as given up",
			).toEqual([a]),
		);
		expect(
			said.filter((line) => line.includes("nothing watches its wake")),
			"rested, so nothing is said",
		).toEqual([]);
	});

	it("says so, and why, when nothing can watch a parked one's wake", async () => {
		resting = false;
		givingUp = "its marker names another holder's wake, /elsewhere/wake";
		await children.backend.resume(held[0] as RosterEntry, false);
		await units.childOf(a).end("parked");
		await vi.waitFor(() =>
			expect(said).toContain(
				`${a}: its child ended parked, and nothing watches its wake until it is asked for, as its marker names another holder's wake, /elsewhere/wake`,
			),
		);
	});

	it("leaves each child running as it closes, and stops reading the policy", async () => {
		await children.backend.resume(held[0] as RosterEntry, false);
		children.close();
		// A turn of the loop, so a stop the close set off would have begun.
		await new Promise((turned) => setImmediate(turned));
		expect(policy.close, "the policy is no longer read").toHaveBeenCalled();
		expect(units.stopped, "no child is stopped").toEqual([]);
		expect(units.childOf(a), "the child still runs").toBeDefined();
	});
});
