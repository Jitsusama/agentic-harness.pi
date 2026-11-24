/** The host opening new conversations in children of their own; child-adopts.test.ts has a host taking up again the children an earlier host left. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { BEGIN_TOO_LATE } from "../../../host/service/child-requests.ts";
import { slotOf } from "../../../host/service/child-units.ts";
import type { SessionIdentity } from "../../../host/service/protocol.ts";
import type * as StartGate from "../../../host/service/start-gate.ts";
import type { RosterEntry } from "../../../lib/core/session/roster.ts";
import {
	a,
	adopting,
	b,
	childOf,
	conversation,
	deferred,
	derived,
	ended,
	entry,
	folder,
	growing,
	key,
	LISTENS_AFTER_MS,
	opening,
	pause,
	reported,
	roster,
	routes,
	slotNamed,
	superviseAgain,
	superviseEachTest,
	supervisor,
	units,
} from "./support/supervised-children.ts";

/** Each turn asked of the supervisor's gate, in the order it was asked. */
const gateAsks = vi.hoisted((): { ahead: boolean }[] => []);

// The real gate, its asks seen, so a case can wait for a start to be
// queued rather than guess how long it takes to get there.
vi.mock("../../../host/service/start-gate.ts", async (original) => {
	const actual = await original<typeof StartGate>();
	return {
		...actual,
		startGate: (atOnce: number): StartGate.StartGate => {
			const gate = actual.startGate(atOnce);
			return {
				turn(ask) {
					gateAsks.push({ ahead: ask.ahead });
					return gate.turn(ask);
				},
			};
		},
	};
});

superviseEachTest();

describe("a new conversation", () => {
	it("is opened by its child, which the host then routes to under the id it answers", async () => {
		const reply = await supervisor.begin({
			...opening("open-1"),
			expectedHost: { key, owner: { pid: 1, startedAt: 1 } },
		});

		expect(reply).toMatchObject({ id: "open-1", ok: true });
		const opened = reply.ok ? (reply.result as SessionIdentity) : undefined;
		const child = childOf(opened?.sessionId ?? "");
		expect(child.asked[0], "asked without the host's identity").toEqual(
			opening("open-1"),
		);
		expect(routes.routeOf(opened?.sessionId ?? "")?.identity).toEqual(
			child.identity,
		);
		const slot = child.slot;
		expect(
			JSON.parse(await readFile(slot.file, "utf8")),
			"a slot naming what it opened, for the next host",
		).toEqual({ session: derived(opened?.sessionId ?? "") });
		expect(roster.held, "held as its child derived it").toEqual([
			entry(a),
			derived(opened?.sessionId ?? ""),
		]);
	});

	it("tells the caller its child's refusal, and stops that child", async () => {
		units.next = { refuses: true };

		const reply = await supervisor.begin({
			...opening("open-2"),
			cwd: "/nowhere",
		});

		expect(reply).toMatchObject({
			id: "open-2",
			ok: false,
			error: { message: "no such folder" },
		});
		expect(units.stopped).toEqual(units.started);
		expect(routes.listed()).toEqual([]);
		const slot = slotNamed(units.started[0] ?? "");
		await vi.waitFor(() =>
			expect(existsSync(slot.file), "its slot is cleared").toBe(false),
		);
	});

	it("takes a child's own child_unreachable as its refusal, not as no answer", async () => {
		let connections = 0;
		units.next = {
			refuses: true,
			refusesWith: "child_unreachable",
			connected: () => {
				connections += 1;
			},
		};

		const reply = await supervisor.begin(opening("open-7"));

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "child_unreachable" },
		});
		expect(connections, "asked its open, and never watched").toBe(1);
		expect(units.stopped).toEqual(units.started);
		expect(routes.listed()).toEqual([]);
	});

	it("refuses a child that opens a conversation the roster holds already", async () => {
		units.next = { opensAs: a };

		await expect(supervisor.begin(opening("open-8"))).rejects.toThrow(
			`opened ${a}, which the roster holds already`,
		);

		// Stopped once its slot is marked, for a host ending before the stop.
		await vi.waitFor(() => expect(units.stopped).toEqual(units.started));
		expect(routes.routeOf(a), "no route taken from it").toBeUndefined();
		expect(roster.held).toEqual([entry(a)]);
	});

	it("refuses an adopt of a file the roster holds before any child opens it", async () => {
		units.next = { opensAs: a };

		await expect(supervisor.begin(adopting("adopt-1", a))).rejects.toThrow(
			`Conversation already held: ${entry(a).file}`,
		);

		expect(units.started, "no child started on its file").toEqual([]);
		expect(routes.routeOf(a), "no route taken from it").toBeUndefined();
		expect(roster.held).toEqual([entry(a)]);
	});

	it("refuses a second adopt of one file while the first is under way", async () => {
		const listens = deferred();
		units.next = { listensWhen: listens.promise };

		const first = supervisor.begin(adopting("adopt-2", b));
		await expect(supervisor.begin(adopting("adopt-3", b))).rejects.toThrow(
			`Conversation already held: ${entry(b).file}`,
		);
		listens.settle();

		expect(await first).toMatchObject({ id: "adopt-2", ok: true });
		expect(units.started, "one child started on the file").toHaveLength(1);
	});

	it("holds what the open asked, not what its child says of it", async () => {
		units.next = {
			answers: (result) => ({
				...result,
				entry: {
					...(result.entry as RosterEntry),
					attended: false,
					quest: "QEST-20261120-AAAAAA",
					launch: { NODE_OPTIONS: "--require=x" },
				},
			}),
		};

		const reply = await supervisor.begin(opening("open-9"));

		const opened = reply.ok ? (reply.result as SessionIdentity) : undefined;
		expect(roster.held).toEqual([entry(a), derived(opened?.sessionId ?? "")]);
	});

	it("names what its child answered in its slot before the roster holds it", async () => {
		const writing = deferred();
		roster.written = writing.promise;

		const beginning = supervisor.begin(opening("open-14"));

		await vi.waitFor(async () => {
			const slot = slotNamed(units.started[0] ?? "");
			const named = JSON.parse(await readFile(slot.file, "utf8"));
			expect(named.session, "named for the next host").toBeDefined();
		});
		expect(roster.held, "not held yet").toEqual([entry(a)]);
		writing.settle();
		expect(await beginning).toMatchObject({ ok: true });
	});

	it("names an unanswered open's conversation when its ask had time of its own", async () => {
		superviseAgain({
			clocks: {
				beginsWithinMs: 2_000,
				unsettledWithinMs: 1_000,
				answersWithinMs: 5_000,
			},
		});
		units.next = { opensUnanswered: true };

		const reply = await supervisor.begin(opening("open-15"));

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "open_unsettled" },
		});
		expect(routes.listed(), "routed to what it built").toHaveLength(1);
	});

	it("refuses a child whose watch names another conversation than it opened", async () => {
		units.next = {
			answers: (result) => ({ ...result, conversation: conversation(b) }),
		};

		await expect(supervisor.begin(opening("open-9"))).rejects.toThrow(
			`runs ${b}, not`,
		);

		await vi.waitFor(() => expect(units.stopped).toEqual(units.started));
		expect(routes.listed()).toEqual([]);
		expect(roster.held).toEqual([entry(a)]);
	});

	it("gives a caller its answer within the time a begin may take", async () => {
		superviseAgain({
			clocks: { beginsWithinMs: 1_000, answersWithinMs: 5_000 },
		});
		units.next = { silent: true };
		const asked = Date.now();

		const reply = await supervisor.begin(opening("open-10"));

		expect(reply).toMatchObject({ ok: false });
		expect(
			Date.now() - asked,
			"within its time, not its answer's",
		).toBeLessThan(3_000);
	});

	// 23 November (ff6ecdd4): its time ran from after the host's rollout
	// census, so the caller's 120 s ran out before the begin's 100 s did.
	it("counts a begin's time from when the host took its request", async () => {
		superviseAgain({
			clocks: {
				beginsWithinMs: 6_000,
				unsettledWithinMs: 1_000,
				answersWithinMs: 10_000,
			},
		});
		units.next = { silent: true };
		const took = Date.now() - 4_000;

		const reply = await supervisor.begin(opening("open-17"), took);

		expect(reply, "its silent child unreachable").toMatchObject({
			ok: false,
			error: { code: "child_unreachable" },
		});
		expect(units.started, "begun, with time left for its child").toHaveLength(
			1,
		);
		const spent = Date.now() - took;
		// The whole begin: its child's ask ends at 5 s from when it was
		// taken, and the watch kept back after it at 6 s.
		expect(spent, "its child given the time left").toBeGreaterThanOrEqual(
			4_500,
		);
		expect(spent, "within its time from when it was taken").toBeLessThan(7_500);
	});

	it("refuses a begin taken too long ago for its child to answer, starting none", async () => {
		superviseAgain({
			clocks: { beginsWithinMs: 10_000, unsettledWithinMs: 5_000 },
		});
		const took = Date.now() - 6_000;

		const reply = await supervisor.begin(opening("open-18"), took);

		expect(reply).toMatchObject({
			id: "open-18",
			ok: false,
			error: { code: BEGIN_TOO_LATE },
		});
		const message = reply.ok ? "" : reply.error.message;
		expect(message).toMatch(/spent \d+ s of its 10 s/);
		expect(message).toContain("nothing was opened");
		expect(message, "asks for a wait").toContain("in a minute");
		expect(units.started, "no child started").toEqual([]);
		expect(routes.listed()).toEqual([]);
		expect(reported.map(String), "said where its time went").toEqual([
			`Request open-18: ${message}`,
		]);
	});

	// Held comes first: told too late, its caller would ask again in a
	// minute for a file no begin will ever take.
	it("refuses an adopt of a held file as held, even when too late", async () => {
		superviseAgain({
			clocks: { beginsWithinMs: 10_000, unsettledWithinMs: 5_000 },
		});

		await expect(
			supervisor.begin(adopting("adopt-5", a), Date.now() - 6_000),
		).rejects.toThrow(`Conversation already held: ${entry(a).file}`);

		expect(units.started, "no child started").toEqual([]);
		expect(reported, "nothing said of a late begin").toEqual([]);
	});

	// A request's id and quest are only the caller's words.
	it("names a late begin's quest in the journal, on one plain line", async () => {
		superviseAgain({
			clocks: { beginsWithinMs: 10_000, unsettledWithinMs: 5_000 },
		});
		const asked = {
			...opening("open-21\nforged"),
			quest: "QEST-20261123-AAAAAA\nHost stopped",
		};

		const reply = await supervisor.begin(asked, Date.now() - 6_000);

		const message = reply.ok ? "" : reply.error.message;
		expect(reported.map(String), "one line, its quest named").toEqual([
			`Request open-21 forged for quest QEST-20261123-AAAAAA Host stopped: ${message}`,
		]);
	});

	// A begin left more than its watch but less than its child needs to
	// start and answer would start a unit only to stop it again.
	it("refuses a begin left too little for its child to start and answer", async () => {
		superviseAgain({
			clocks: {
				beginsWithinMs: 10_000,
				unsettledWithinMs: 2_000,
				leastFirstAskMs: 4_000,
			},
		});
		const took = Date.now() - 5_000;

		const reply = await supervisor.begin(opening("open-19"), took);

		expect(reply).toMatchObject({ ok: false, error: { code: BEGIN_TOO_LATE } });
		expect(units.started, "no child started").toEqual([]);
	});

	it("refuses a begin left exactly its least, and begins one left a millisecond more", async () => {
		superviseAgain({
			clocks: {
				beginsWithinMs: 10_000,
				unsettledWithinMs: 2_000,
				leastFirstAskMs: 4_000,
			},
		});
		// The clock held still while each begin weighs its time, which it
		// does before it first waits.
		vi.useFakeTimers({ toFake: ["Date"] });
		const refused = supervisor.begin(opening("open-20"), Date.now() - 4_000);
		const begun = supervisor.begin(opening("open-21"), Date.now() - 3_999);
		vi.useRealTimers();

		expect(await refused).toMatchObject({
			id: "open-20",
			error: { code: BEGIN_TOO_LATE },
		});
		expect(await begun).toMatchObject({ id: "open-21", ok: true });
		expect(units.started, "only the second started").toHaveLength(1);
	});

	it("refuses a begin with no time left, when its whole time is less than its watch", async () => {
		superviseAgain({
			clocks: { beginsWithinMs: 1_000, unsettledWithinMs: 5_000 },
		});

		const reply = await supervisor.begin(
			opening("open-22"),
			Date.now() - 1_000,
		);

		expect(reply).toMatchObject({ ok: false, error: { code: BEGIN_TOO_LATE } });
		expect(units.started, "no child started").toEqual([]);
	});

	it("gives up on a starved child at its listen time, since its caller waits on it", async () => {
		superviseAgain({ clocks: { listensWithinMs: 300 } });
		units.next = { neverListens: true };
		units.spent = 0;
		const asked = Date.now();

		await expect(supervisor.begin(opening("open-16"))).rejects.toThrow(
			/did not listen within 300 ms$/,
		);
		expect(
			Date.now() - asked,
			"within its listen time, not a starved child's",
		).toBeLessThan(3_000);
		expect(units.cpuAsks, "its refusal not held up by asking systemd").toBe(0);
	});

	it("gives a starved child no more than its answer time to answer its watch, since its caller waits on it", async () => {
		superviseAgain({ clocks: { starvedWithinMs: 10_000 } });
		units.next = { answersWatchAfterMs: 2_500 };
		units.spent = growing(200, 20);
		const asked = Date.now();

		await expect(supervisor.begin(opening("open-17"))).rejects.toThrow(
			"The child gave its watch no answer within 500 ms",
		);
		expect(
			Date.now() - asked,
			"within its answer time, not a starved child's",
		).toBeLessThan(2_000);
		expect(units.cpuAsks, "its refusal not held up by asking systemd").toBe(0);
	});

	it("refuses a begin that waits for its turn to start past its own time, starting no child for it", async () => {
		superviseAgain({ clocks: { beginsWithinMs: 400 } });
		// Two starts that never listen keep the gate full for their listen time.
		units.traitsOf = () => ({ neverListens: true });
		const held = [a, b].map((id) => supervisor.resume(entry(id)));
		await vi.waitFor(() => expect(units.started).toHaveLength(2));
		const asked = Date.now();

		// F30: refused as too late, so its caller asks again, not as a failure.
		const refused = await supervisor.begin(opening("open-18"));
		expect(refused).toMatchObject({
			id: "open-18",
			ok: false,
			error: {
				code: "begin_too_late",
				message: expect.stringContaining("waiting for its turn"),
			},
		});
		expect(Date.now() - asked, "at its time, not later").toBeLessThan(1_000);
		expect(
			reported.map(String),
			"the journal says where its time went",
		).toContainEqual(
			expect.stringContaining("Request open-18: The host spent"),
		);
		expect(units.started, "no unit started for it").toHaveLength(2);
		supervisor.close();
		for (const one of held) await expect(one).rejects.toThrow();
	});

	// F37: its caller waits on it, as a wake's writer does.
	it("starts a begin before the resumes queued ahead of it", async () => {
		// Freed one at a time: two turns freed at once start the begin and
		// the queued resume together, and which reaches its unit's start
		// first is their own writes' race, not the gate's order.
		const holdingA = deferred();
		const holdingB = deferred();
		units.traitsOf = (unit) => {
			if (unit === slotOf(folder, key, a).unit)
				return { listensWhen: holdingA.promise };
			if (unit === slotOf(folder, key, b).unit)
				return { listensWhen: holdingB.promise };
			return {};
		};
		gateAsks.length = 0;
		const held = [a, b].map((id) => supervisor.resume(entry(id)));
		await vi.waitFor(() => expect(units.started).toHaveLength(2));
		const queued = "c0000000-0000-4000-8000-000000000003";
		const later = supervisor.resume(entry(queued));
		// A begin reaches the gate at once and a resume only after its own
		// awaits, so the resume is seen waiting before the begin asks.
		await vi.waitFor(() => expect(gateAsks).toHaveLength(3));
		const beginning = supervisor.begin(opening("open-24"));
		const all = [...held, beginning, later];
		try {
			expect(gateAsks, "the resume queued, then the begin ahead").toEqual([
				{ ahead: false },
				{ ahead: false },
				{ ahead: false },
				{ ahead: true },
			]);
			// Long enough for a begin let past a full gate to reach its unit's start.
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(units.started, "none past the gate while it is full").toHaveLength(
				2,
			);

			holdingA.settle();
			await vi.waitFor(() => expect(units.started).toHaveLength(3));
			expect(
				units.started[2],
				"the begin given the first turn freed, not the resume that came first",
			).not.toBe(slotOf(folder, key, queued).unit);
			holdingB.settle();
			await Promise.all(all);
			expect(units.started[3]).toBe(slotOf(folder, key, queued).unit);
		} finally {
			// A failed check leaves none of them pending past the case.
			holdingA.settle();
			holdingB.settle();
			await Promise.allSettled(all);
		}
	});

	// A turn given with less than its least left would start a unit only
	// to stop it again, as a begin weighed too late would.
	it("stops a begin's wait for its turn once less than its least is left", async () => {
		superviseAgain({
			clocks: {
				beginsWithinMs: 2_400,
				unsettledWithinMs: 400,
				leastFirstAskMs: 800,
			},
		});
		units.traitsOf = () => ({ neverListens: true });
		const held = [a, b].map((id) => supervisor.resume(entry(id)));
		await vi.waitFor(() => expect(units.started).toHaveLength(2));
		const asked = Date.now();

		const refused = await supervisor.begin(opening("open-23"), asked);
		expect(refused).toMatchObject({
			ok: false,
			error: { code: "begin_too_late" },
		});
		const waited = Date.now() - asked;
		expect(
			waited,
			"at its time less its least, not its whole time",
		).toBeLessThan(2_000);
		// Its least is its unsettled time and least first ask, 400 + 800 ms,
		// so its turn lapses 2400 - 1200 ms after it was asked.
		expect(
			waited,
			"waited out its time less its least, not refused at once",
		).toBeGreaterThanOrEqual(1_100);
		expect(units.started, "no unit started for it").toHaveLength(2);
		supervisor.close();
		for (const one of held) await expect(one).rejects.toThrow();
	});

	it("ends a begin as soon as the host stops watching during its ask", async () => {
		superviseAgain({ clocks: { answersWithinMs: 5_000 } });
		units.next = { silent: true };
		const beginning = supervisor.begin(opening("open-11"));
		await vi.waitFor(() =>
			expect([...units.children.values()][0]?.asked ?? []).toHaveLength(1),
		);
		const closed = Date.now();

		supervisor.close();

		await expect(beginning).rejects.toThrow("stopped watching");
		expect(Date.now() - closed, "not after its answer's time").toBeLessThan(
			1_000,
		);
		expect(units.stopped, "left running").toEqual([]);
	});

	it("resumes what it opened only once the slot it ran in is empty", async () => {
		const reply = await supervisor.begin(opening("open-12"));
		const opened = reply.ok ? (reply.result as SessionIdentity) : undefined;
		const id = opened?.sessionId ?? "";
		const first = childOf(id);
		first.say({ type: "ending", why: "parked" });
		await vi.waitFor(() => expect(ended).toEqual([[id, "parked"]]));

		const again = supervisor.resume(derived(id), true);
		await vi.waitFor(() => expect(units.started).toHaveLength(2));

		expect(
			units.children.has(first.slot.unit),
			"the open's child went first",
		).toBe(false);
		expect((await again).sessionId).toBe(id);
	});

	it("fails, and stops its child, when the roster won't hold what it opened", async () => {
		roster.refuses = true;

		await expect(supervisor.begin(opening("open-3"))).rejects.toThrow(
			"can't be written",
		);

		expect(units.stopped).toEqual(units.started);
		expect(routes.listed()).toEqual([]);
	});

	it("names the conversation a child built but never answered for, holding it", async () => {
		units.next = { opensUnanswered: true };

		const reply = await supervisor.begin(opening("open-5"));

		expect(reply).toMatchObject({
			id: "open-5",
			ok: false,
			error: { code: "open_unsettled" },
		});
		const [running] = routes.listed();
		expect(running, "routed to").toBeDefined();
		expect(reply.ok ? "" : reply.error.message).toContain(
			running?.sessionId ?? "none",
		);
		expect(roster.held).toEqual([entry(a), derived(running?.sessionId ?? "")]);
		expect(units.stopped, "left running").toEqual([]);
	});

	it("asks nothing of its child when the host stops watching as it starts", async () => {
		let connections = 0;
		const listening = deferred();
		units.next = {
			connected: () => {
				connections += 1;
			},
			listensWhen: listening.promise,
		};
		const beginning = supervisor.begin(opening("open-6"));
		// Its unit has started, and its child listens only once let.
		await vi.waitFor(() => expect(units.started).toHaveLength(1));

		supervisor.close();
		listening.settle();

		await expect(beginning).rejects.toThrow("stopped watching");
		// Long enough for its child to listen, and so to be asked if it were.
		await pause(LISTENS_AFTER_MS * 2);
		const [child] = [...units.children.values()];
		expect(child, "it listens").toBeDefined();
		expect(connections, "nothing reached it").toBe(0);
		expect(units.stopped).toEqual([]);
	});

	it("tells the caller a child that never answers doesn't, and stops it", async () => {
		units.next = { silent: true };

		const reply = await supervisor.begin(opening("open-4"));

		expect(reply).toMatchObject({
			id: "open-4",
			ok: false,
			error: { code: "child_unreachable" },
		});
		expect(units.stopped).toEqual(units.started);
	});
});
