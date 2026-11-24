/**
 * Liveness: whether a peer is still on the mesh, asked of the machine.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProcessFacts } from "../../../lib/core/process/index.ts";
import {
	type TickFacts,
	tickedOwnerNow,
} from "../../../lib/internal/process-ticks.ts";
import {
	census,
	type HeldAsk,
	heldOnce,
	livenessOf,
	RESUME_GRACE_MS,
} from "../../../lib/mesh/liveness.ts";
import type { AskNode, Held } from "../../../lib/mesh/node.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";

/** A machine on which these pids run, started at these times. */
function machine(running: Record<number, number>): ProcessFacts & {
	asked: number[];
} {
	const asked: number[] = [];
	return {
		asked,
		alive: (pid) => pid in running,
		startedAt: async (pid) => {
			asked.push(pid);
			return running[pid];
		},
	};
}

const presence = (over: Partial<Presence> = {}): Presence => ({
	session: "s-1",
	addresses: ["P9R1KI"],
	groups: [],
	worksOn: "",
	owns: [],
	busy: false,
	at: "2026-10-22T03:00:00.000Z",
	...over,
});

describe("a peer's liveness", () => {
	it("is present while the process that holds it runs", async () => {
		const one = presence({ owner: { pid: 40, startedAt: 1000 } });

		expect(await livenessOf(one, machine({ 40: 1000 }))).toBe("present");
	});

	it("is gone once that process has ended", async () => {
		const one = presence({ owner: { pid: 40, startedAt: 1000 } });

		expect(await livenessOf(one, machine({}))).toBe("gone");
	});

	it("is present once parked, its process gone, while its marker stands", async () => {
		const one = presence({
			owner: { pid: 40, startedAt: 1000 },
			state: "parked",
		});
		const marked = (session: string) => session === "s-1";

		expect(await livenessOf(one, machine({}), undefined, marked)).toBe(
			"present",
		);
		expect(await livenessOf(one, machine({}), undefined, () => false)).toBe(
			"gone",
		);
		// A marker says nothing of a peer that never said it parked.
		const ended = presence({ owner: { pid: 40, startedAt: 1000 } });
		expect(await livenessOf(ended, machine({}), undefined, marked)).toBe(
			"gone",
		);
		const { present } = await census([one], machine({}), undefined, marked);
		expect(present.map((peer) => peer.session)).toEqual(["s-1"]);
	});

	it("is gone when a new process wears its pid", async () => {
		const one = presence({ owner: { pid: 40, startedAt: 1000 } });

		expect(await livenessOf(one, machine({ 40: 900_000 }))).toBe("gone");
	});

	it("cannot be told for a presence that names no process", async () => {
		expect(await livenessOf(presence(), machine({}))).toBe("unknown");
	});

	it("is resuming while its host restarts, as long as its host brings it back", async () => {
		const one = hostedPresence();
		const { ask, asked } = holding(true);

		const gone = machine({});
		expect(await livenessOf(one, gone, undefined, () => false, ask)).toBe(
			"resuming",
		);
		expect(asked).toEqual(["work-background/c-1"]);
		// Closed, released, never brought back, or a roster that can't be read.
		expect(
			await livenessOf(one, gone, undefined, () => false, holding(false).ask),
		).toBe("gone");

		const standing = await census(
			[one, presence({ owner: { pid: 41, startedAt: 1000 } })],
			gone,
			undefined,
			() => false,
			holding(true).ask,
		);
		expect(standing.present.map((peer) => peer.session)).toEqual(["c-1"]);
		expect(standing.resuming.map((peer) => peer.session)).toEqual(["c-1"]);
		expect(standing.gone.map((peer) => peer.session)).toEqual(["s-1"]);
	});

	it("is gone once a running session answers to its address again", async () => {
		const past = hostedPresence({ addresses: ["AGAIN1"] });
		const still = hostedPresence({
			session: "c-2",
			addresses: ["BACK01"],
			hosted: { host: "work-background", conversation: "c-2" },
		});
		const live = presence({
			session: "s-2",
			addresses: ["AGAIN1"],
			owner: { pid: 41, startedAt: 1000 },
		});

		const standing = await census(
			[past, still, live],
			machine({ 41: 1000 }),
			undefined,
			() => false,
			holding(true).ask,
		);
		expect(
			standing.present.map((peer) => peer.session),
			"its past is no peer for joins, sends or pivots to count",
		).toEqual(["c-2", "s-2"]);
		expect(standing.resuming.map((peer) => peer.session)).toEqual(["c-2"]);
		expect(standing.gone.map((peer) => peer.session)).toEqual(["c-1"]);
	});

	it("tells the roster when the process that last ran it started", async () => {
		const starts: (number | undefined)[] = [];
		const ask: HeldAsk = async (_conversation, _host, ranFrom) => {
			starts.push(ranFrom);
			return true;
		};

		await livenessOf(
			hostedPresence(),
			machine({}),
			undefined,
			() => false,
			ask,
		);
		expect(starts).toEqual([1000]);
	});

	it("asks no roster of a hosted peer still running or parked", async () => {
		const { ask, asked } = holding(false);
		const running: TickFacts = {
			...machine({ 40: 1000 }),
			sessionStanding: () => "running",
		};
		expect(
			await livenessOf(hostedPresence(), running, undefined, () => false, ask),
		).toBe("present");
		const parked = hostedPresence({ state: "parked" });
		expect(
			await livenessOf(parked, machine({}), undefined, () => true, ask),
		).toBe("present");
		expect(asked).toEqual([]);
	});

	it("never asks a roster of a peer no host holds", async () => {
		const one = presence({ owner: { pid: 40, startedAt: 1000 } });
		const { ask, asked } = holding(true);

		expect(
			await livenessOf(one, machine({}), undefined, () => false, ask),
		).toBe("gone");
		expect(asked).toEqual([]);
	});
});

/** A presence on conversation c-1 that the work-background host holds. */
function hostedPresence(over: Partial<Presence> = {}): Presence {
	return presence({
		session: "c-1",
		owner: { pid: 40, startedAt: 1000 },
		state: "busy",
		hosted: { host: "work-background", conversation: "c-1" },
		...over,
	});
}

/** A roster answering `answer`, keeping each host and conversation asked. */
function holding(answer: boolean): { ask: HeldAsk; asked: string[] } {
	const asked: string[] = [];
	return {
		asked,
		ask: async (conversation, host) => {
			asked.push(`${host}/${conversation}`);
			return answer;
		},
	};
}

describe("whether a restarting host is bringing a conversation back", () => {
	const CONVERSATION = "01a1f23f-0000-7000-8000-000000000001";
	const NOW = 2_000_000_000_000;
	const HOST_PID = 700;
	const CHILD_PID = 701;
	let root: string;
	let rosters: string;
	let hosts: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "held-once-"));
		rosters = join(root, "rosters");
		hosts = join(root, "hosts");
		mkdirSync(rosters);
		mkdirSync(hosts);
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const keep = (key: string, ids: readonly string[]) =>
		writeFileSync(
			join(rosters, `${key}.json`),
			JSON.stringify({
				v: 1,
				key,
				sessions: ids.map((sessionId) => ({
					sessionId,
					file: `/sessions/${sessionId}.jsonl`,
					cwd: "/work",
					attended: false,
					since: "2026-11-21T09:00:00.000Z",
				})),
			}),
		);
	// The host holds its roster's lock for its whole run.
	const hostStarted = (agoMs: number) =>
		writeFileSync(
			join(rosters, "work-background.json.lock"),
			JSON.stringify({
				key: "work-background",
				owner: { pid: HOST_PID, startedAt: NOW - agoMs },
			}),
		);
	// A process listing what it has open, as each child does under its
	// host's key.
	const listed = (
		pid: number,
		agoMs: number,
		open: readonly string[] = [],
		key = "work-background",
		state: "busy" | "parked" = "busy",
	) =>
		writeFileSync(
			join(hosts, `${pid}-${NOW - agoMs}.json`),
			JSON.stringify({
				key,
				owner: { pid, startedAt: NOW - agoMs },
				sessions: open.map((id) => ({
					id,
					state,
					since: "2026-11-21T09:00:00.000Z",
				})),
			}),
		);
	const ask = (running: Record<number, number> = {}) =>
		heldOnce(machine(running), { rosters, hosts, now: NOW });
	const PAST = RESUME_GRACE_MS * 3;

	it("is not while no host runs under its key, however long it holds it", async () => {
		keep("work-background", [CONVERSATION]);

		expect(
			await ask()(CONVERSATION, "work-background"),
			"not resuming with no lock, as a host stopped leaves it",
		).toBe(false);
		hostStarted(60_000);
		expect(
			await ask()(CONVERSATION, "work-background"),
			"not resuming while the lock names a host gone",
		).toBe(false);
	});

	it("is while the host running again started within the grace", async () => {
		keep("work-background", [CONVERSATION]);
		const ago = RESUME_GRACE_MS - 60_000;
		hostStarted(ago);

		expect(
			await ask({ [HOST_PID]: NOW - ago })(CONVERSATION, "work-background"),
			"resuming while the running host is within the grace",
		).toBe(true);
	});

	it("is not once the host running again is past the grace and never brought it back", async () => {
		keep("work-background", [CONVERSATION]);
		const ago = RESUME_GRACE_MS + 60_000;
		hostStarted(ago);

		expect(
			await ask({ [HOST_PID]: NOW - ago })(CONVERSATION, "work-background"),
			"not resuming once the running host is past the grace",
		).toBe(false);
	});

	it("is while a process under the key past the grace has it open, its presence not yet written again", async () => {
		keep("work-background", [CONVERSATION]);
		hostStarted(PAST);
		listed(CHILD_PID, 30_000, [CONVERSATION]);

		expect(
			await ask({ [HOST_PID]: NOW - PAST, [CHILD_PID]: NOW - 30_000 })(
				CONVERSATION,
				"work-background",
			),
			"resuming while its own child has it open",
		).toBe(true);
	});

	it("measures the grace from the host, not a child that started under its key since", async () => {
		keep("work-background", [CONVERSATION]);
		hostStarted(PAST);
		listed(CHILD_PID, 60_000, ["01a1f23f-0000-7000-8000-000000000002"]);

		expect(
			await ask({ [HOST_PID]: NOW - PAST, [CHILD_PID]: NOW - 60_000 })(
				CONVERSATION,
				"work-background",
			),
			"another conversation's new child gives no grace",
		).toBe(false);
	});

	it("is not past the grace when the host's list keeps it parked, as a start that failed leaves it", async () => {
		keep("work-background", [CONVERSATION]);
		hostStarted(PAST);
		listed(HOST_PID, PAST, [CONVERSATION], "work-background", "parked");

		expect(
			await ask({ [HOST_PID]: NOW - PAST })(CONVERSATION, "work-background"),
			"a failed resume, kept parked, is not open",
		).toBe(false);
	});

	it("is not when the process that last ran it started after the host did", async () => {
		keep("work-background", [CONVERSATION]);
		hostStarted(60_000);
		const running = { [HOST_PID]: NOW - 60_000 };

		expect(
			await ask(running)(CONVERSATION, "work-background", NOW - 30_000),
			"brought back by this host already, then ended",
		).toBe(false);
		// A conversation in the host's own process carries the host's start.
		expect(
			await ask(running)(CONVERSATION, "work-background", NOW - 60_000),
			"run in this host's own process, then ended",
		).toBe(false);
		expect(
			await ask(running)(CONVERSATION, "work-background", NOW - PAST),
			"run before this host started, so still to come back",
		).toBe(true);
	});

	it("takes a host or a listing process that can't be told as running", async () => {
		keep("work-background", [CONVERSATION]);
		const untold = {
			alive: () => true,
			startedAt: async () => undefined,
		};
		hostStarted(60_000);
		expect(
			await heldOnce(untold, { rosters, hosts, now: NOW })(
				CONVERSATION,
				"work-background",
			),
			"a holder that can't be told is not taken as gone",
		).toBe(true);
		hostStarted(PAST);
		listed(CHILD_PID, 30_000, [CONVERSATION]);
		expect(
			await heldOnce(untold, { rosters, hosts, now: NOW })(
				CONVERSATION,
				"work-background",
			),
			"nor a listing process that can't be told",
		).toBe(true);
	});

	it("counts only what processes under its own key, still running, have open", async () => {
		keep("work-background", [CONVERSATION]);
		hostStarted(PAST);
		listed(CHILD_PID, 30_000, [CONVERSATION], "work-attended");
		listed(702, 30_000, [CONVERSATION]);

		expect(
			await ask({ [HOST_PID]: NOW - PAST, [CHILD_PID]: NOW - 30_000 })(
				CONVERSATION,
				"work-background",
			),
			"another key's list, or a listing process gone, says nothing",
		).toBe(false);
	});

	it("reads the host lists once a census, and not at all within the grace", async () => {
		keep("work-background", [CONVERSATION]);
		hostStarted(PAST);
		listed(CHILD_PID, 30_000, [CONVERSATION]);
		const running = { [HOST_PID]: NOW - PAST, [CHILD_PID]: NOW - 30_000 };
		const once = ask(running);
		expect(
			await once(CONVERSATION, "work-background"),
			"the first ask reads the lists",
		).toBe(true);

		rmSync(hosts, { recursive: true });
		expect(
			await once(CONVERSATION, "work-background"),
			"the same census answers from the lists it read",
		).toBe(true);
		expect(
			await ask(running)(CONVERSATION, "work-background"),
			"a new census reads the lists again",
		).toBe(false);
		mkdirSync(hosts);
		listed(CHILD_PID, 30_000, [CONVERSATION]);
		hostStarted(60_000);
		const within = machine({
			[HOST_PID]: NOW - 60_000,
			[CHILD_PID]: NOW - 30_000,
		});
		expect(
			await heldOnce(within, { rosters, hosts, now: NOW })(
				CONVERSATION,
				"work-background",
			),
			"resuming within the grace",
		).toBe(true);
		expect(
			within.asked,
			"within the grace no listing process is asked about",
		).not.toContain(CHILD_PID);
	});

	// With the host running within its grace, only the roster can say no.
	it("reads only the named host's roster, not another host's", async () => {
		hostStarted(60_000);
		const running = { [HOST_PID]: NOW - 60_000 };
		keep("work-attended", [CONVERSATION]);

		expect(
			await ask(running)(CONVERSATION, "work-background"),
			"another host's roster says nothing of this one",
		).toBe(false);
		keep("work-background", []);
		expect(
			await ask(running)(CONVERSATION, "work-background"),
			"the named roster not holding it",
		).toBe(false);
	});

	it("is not when the roster can't be read", async () => {
		hostStarted(60_000);
		writeFileSync(join(rosters, "work-background.json"), "{ half");

		expect(
			await ask({ [HOST_PID]: NOW - 60_000 })(CONVERSATION, "work-background"),
			"an unreadable roster holds nothing",
		).toBe(false);
	});

	it("reads each roster once however many it is asked about", async () => {
		keep("work-background", [CONVERSATION]);
		hostStarted(60_000);
		const running = { [HOST_PID]: NOW - 60_000 };
		const once = ask(running);
		expect(
			await once(CONVERSATION, "work-background"),
			"the first ask reads the roster",
		).toBe(true);

		rmSync(join(rosters, "work-background.json"));
		expect(
			await once(CONVERSATION, "work-background"),
			"the same census answers from the roster it read",
		).toBe(true);
		expect(
			await ask(running)(CONVERSATION, "work-background"),
			"a new census reads the roster again",
		).toBe(false);
	});
});

/** A node holding these sessions, counting how often it is asked. */
function node(held: Record<string, Held> | undefined): AskNode & {
	asked: () => number;
} {
	let asked = 0;
	return Object.assign(
		async () => {
			asked++;
			return held && new Map(Object.entries(held));
		},
		{ asked: () => asked },
	);
}

describe("a session elsewhere's liveness", () => {
	const carried = presence({ session: "far", machine: "equilibrius" });

	it("is present while the node carrying it holds it busy or idle", async () => {
		expect(
			await livenessOf(carried, machine({}), node({ far: "busy" })),
			"a busy session",
		).toBe("present");
		expect(
			await livenessOf(carried, machine({}), node({ far: "idle" })),
			"an idle session",
		).toBe("present");
	});

	it("is gone once the node says it ended, or holds it no more", async () => {
		expect(
			await livenessOf(carried, machine({}), node({ far: "ended" })),
			"an ended session",
		).toBe("gone");
		expect(
			await livenessOf(carried, machine({}), node({})),
			"a session the node doesn't hold",
		).toBe("gone");
	});

	// A session parked there between turns has no process, so its node
	// holds it ended, but the presence it wrote says parked: what is sent
	// to it starts it again, as a park here does.
	it("is present while its node holds it ended and its presence says it parked", async () => {
		const parked = presence({
			session: "far",
			machine: "equilibrius",
			state: "parked",
		});

		expect(
			await livenessOf(parked, machine({}), node({ far: "ended" })),
			"a parked session its node holds ended",
		).toBe("present");
		expect(
			await livenessOf(parked, machine({}), node({})),
			"a parked session its node holds no more",
		).toBe("gone");
		// Only a park: a session that last said anything else and ended is gone.
		for (const state of ["listening", "busy", "waiting", "paused"] as const) {
			expect(
				await livenessOf(
					presence({ session: "far", machine: "equilibrius", state }),
					machine({}),
					node({ far: "ended" }),
				),
				`an ended session that last said ${state}`,
			).toBe("gone");
		}
		const { present } = await census(
			[parked],
			machine({}),
			node({ far: "ended" }),
		);
		expect(present.map((one) => one.session)).toEqual(["far"]);
	});

	// A dropped link, or a node a switch is restarting, says nothing of
	// whether the session runs, so its leases and holds stand.
	it("can't be told while its machine is out of reach, or no node answers", async () => {
		expect(
			await livenessOf(carried, machine({}), node({ far: "unreachable" })),
			"a session out of reach",
		).toBe("unknown");
		expect(
			await livenessOf(carried, machine({}), node(undefined)),
			"no node answering",
		).toBe("unknown");
	});

	it("asks the node once a census, and not at all for sessions here", async () => {
		const asking = node({ far: "busy", near: "idle" });
		const other = presence({ session: "near", machine: "equilibrius" });
		const here = presence({
			session: "here",
			owner: { pid: 40, startedAt: 1000 },
		});

		const { present } = await census([carried, other], machine({}), asking);
		await census([here], machine({ 40: 1000 }), asking);

		expect(present.map((one) => one.session)).toEqual(["far", "near"]);
		expect(
			asking.asked(),
			"one ask for two sessions elsewhere, none for one here",
		).toBe(1);
	});
});

/**
 * A machine whose boot clock has moved by `drift` milliseconds since its
 * processes started, as suspends move it, keeping each start in ticks.
 */
function suspended(
	ticks: Record<number, number>,
	drift: number,
	boot = "boot-1",
): TickFacts {
	return {
		alive: (pid) => pid in ticks,
		startedAt: async (pid) =>
			pid in ticks ? 1000 + (ticks[pid] ?? 0) * 10 + drift : undefined,
		bootId: () => boot,
		startTicks: async (pid) => ticks[pid],
	};
}

describe("a peer's liveness across a suspend", () => {
	const owner = { pid: 40, startedAt: 1500, bootId: "boot-1", startTicks: 50 };

	it("stays present though the boot clock moved past core's tolerance", async () => {
		const one = presence({ owner });

		expect(await livenessOf(one, suspended({ 40: 50 }, 4000))).toBe("present");
	});

	it("is gone when a new process wears its pid", async () => {
		const one = presence({ owner });

		expect(await livenessOf(one, suspended({ 40: 51 }, 0))).toBe("gone");
	});

	it("is gone after the machine booted again", async () => {
		const one = presence({ owner });

		expect(await livenessOf(one, suspended({ 40: 50 }, 0, "boot-2"))).toBe(
			"gone",
		);
	});

	it("is judged as before when its presence has no ticks", async () => {
		const { startTicks: _, ...old } = owner;

		expect(
			await livenessOf(presence({ owner: old }), suspended({ 40: 50 }, 4000)),
		).toBe("gone");
		expect(
			await livenessOf(presence({ owner: old }), suspended({ 40: 50 }, 0)),
		).toBe("present");
	});

	it("keeps the ticks through a census", async () => {
		const { present } = await census(
			[presence({ owner })],
			suspended({ 40: 50 }, 4000),
		);

		expect(present).toHaveLength(1);
	});

	it("names this process with its ticks", async () => {
		const now = await tickedOwnerNow(suspended({ [process.pid]: 77 }, 0));

		expect(now).toMatchObject({ pid: process.pid, startTicks: 77 });
	});

	it("leaves the session a pi moved on from, though its start time moved", async () => {
		// Each session start works core's start time out afresh, so the
		// session a pi left before the suspend and the one it holds now
		// name it by different times, and only the ticks match.
		const left = presence({
			session: "s-left",
			owner,
			at: "2026-10-26T01:00:00.000Z",
		});
		const held = presence({
			session: "s-held",
			owner: { ...owner, startedAt: owner.startedAt + 4000 },
			at: "2026-10-26T02:00:00.000Z",
		});

		const { present, gone } = await census(
			[left, held],
			suspended({ 40: 50 }, 4000),
		);

		expect(present.map((one) => one.session)).toEqual(["s-held"]);
		expect(gone.map((one) => one.session)).toEqual(["s-left"]);
	});
});

describe("a census", () => {
	it("keeps the peers that cannot be told among those present", async () => {
		const there = presence({ owner: { pid: 40, startedAt: 1000 } });
		const old = presence({ session: "s-2", addresses: ["WCJQSG"] });
		const ended = presence({
			session: "s-3",
			addresses: ["OVAE1I"],
			owner: { pid: 41, startedAt: 1000 },
		});

		const { present, gone } = await census(
			[there, old, ended],
			machine({ 40: 1000 }),
		);

		expect(present.map((one) => one.session)).toEqual(["s-1", "s-2"]);
		expect(gone.map((one) => one.session)).toEqual(["s-3"]);
	});

	it("counts a session its process has moved on from as gone", async () => {
		// One pi holds one session at a time: /new leaves the last one behind.
		const owner = { pid: 40, startedAt: 1000 };
		const left = presence({ owner, at: "2026-10-22T03:00:00.000Z" });
		const now = presence({
			session: "s-2",
			owner,
			at: "2026-10-22T03:05:00.000Z",
		});

		const { present, gone } = await census([left, now], machine({ 40: 1000 }));

		expect(present.map((one) => one.session)).toEqual(["s-2"]);
		expect(gone.map((one) => one.session)).toEqual(["s-1"]);
	});

	it("asks the machine once per process", async () => {
		const owner = { pid: 40, startedAt: 1000 };
		const facts = machine({ 40: 1000 });

		await census(
			[presence({ owner }), presence({ session: "s-2", owner })],
			facts,
		);

		expect(facts.asked).toEqual([40]);
	});

	it("lists the process table once however many peers it counts", async () => {
		// A Mac has no /proc, so each start time was a `ps` of its own, all
		// at once: fifty peers made fifty children per census in every pi,
		// which left hundreds unreaped and a work Mac at load 155.
		const running: Record<number, number> = {};
		for (let pid = 100; pid < 150; pid++) running[pid] = pid * 1000;
		const facts = machine(running);
		let listings = 0;
		const listing: ProcessFacts = {
			...facts,
			startTimes: async () => {
				listings++;
				return new Map(Object.entries(running).map(([p, at]) => [+p, at]));
			},
		};
		const everyone = Object.keys(running).map((pid) =>
			presence({
				session: `s-${pid}`,
				owner: { pid: +pid, startedAt: +pid * 1000 },
			}),
		);

		const { present } = await census(everyone, listing);

		expect(present).toHaveLength(50);
		expect(listings, "one listing for the whole census").toBe(1);
		expect(facts.asked, "no process asked about on its own").toEqual([]);
	});
});
