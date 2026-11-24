/** The backend starting and waking conversations in children of their own. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionHost } from "../../../host/engine/index.ts";
import {
	type BackendChildren,
	type ConversationEngine,
	hostBackend,
} from "../../../host/service/backend.ts";
import {
	BEGIN_TOO_LATE,
	beganTooLate,
	CHILD_SAID_UNSETTLED,
} from "../../../host/service/child-requests.ts";
import {
	type ControlReply,
	dispatchControl,
} from "../../../host/service/dispatch.ts";
import type {
	ControlRequest,
	SessionIdentity,
} from "../../../host/service/protocol.ts";
import {
	type HeldOrder,
	heldOrder,
	resumeHeld,
} from "../../../host/service/resume-held.ts";
import { type HostRoster, openRoster } from "../../../host/service/roster.ts";
import {
	OPEN_UNSETTLED,
	unsettledMessage,
} from "../../../host/service/unsettled-open.ts";
import type { RosterEntry } from "../../../lib/core/session/roster.ts";

const KEY = "work-background";
const owner = { pid: process.pid, startedAt: 1 };

let dir: string;
let host: SessionHost;
let roster: HostRoster;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "h2-backend-children-"));
	host = new SessionHost({ key: KEY, owner, registryDir: dir });
	roster = await openRoster({
		key: KEY,
		dir: join(dir, "rosters"),
		owner: { ...owner, startTicks: 1 },
	});
});
afterEach(async () => {
	for (const { id } of host.list()) await host.stop(id);
	host.dispose();
	await roster.close();
	await rm(dir, { recursive: true, force: true });
});

function engine(): ConversationEngine {
	return {
		prepare: vi.fn(async () => {
			throw new Error("the host prepared what a child should open");
		}),
		start: vi.fn(async () => {}),
		discard: vi.fn(async () => {}),
		resume: vi.fn(async (entry: RosterEntry) => {
			host.register({
				id: entry.sessionId,
				file: entry.file,
				cwd: entry.cwd,
				env: { PI_SESSION_ID: entry.sessionId },
				close: () => undefined,
			});
		}),
		abort: vi.fn(async () => {}),
		backgroundOf: () => 0,
		movedOut: vi.fn(),
	};
}

function entry(sessionId = randomUUID()): RosterEntry {
	return {
		sessionId,
		file: join(dir, `${sessionId}.jsonl`),
		cwd: dir,
		attended: false,
		since: "2026-11-20T03:00:00.000Z",
	};
}

function shown(held: RosterEntry): SessionIdentity {
	const { sessionId, file, cwd, since } = held;
	return { sessionId, file, cwd, state: "idle", since };
}

/** Children that run what moves, as the supervisor would. */
function children(moving: readonly string[], opening = false) {
	const runs = new Map<string, SessionIdentity>();
	const opened = entry();
	const fake = {
		moves: (sessionId: string) => moving.includes(sessionId),
		opens: () => opening,
		running: (sessionId: string) => runs.get(sessionId),
		resume: vi.fn(async (held: RosterEntry, _woken: boolean) => {
			runs.set(held.sessionId, shown(held));
			return shown(held);
		}),
		begin: vi.fn(
			async (request: { id: string }): Promise<ControlReply> => ({
				v: 1,
				id: request.id,
				ok: true,
				result: shown(opened),
			}),
		),
		ask: vi.fn(async (sessionId: string, _request: ControlRequest) => ({
			sessionId,
			asked: "the child",
		})),
		left: vi.fn(async (_sessionId: string) => {}),
		giveUp: vi.fn((_sessionId: string) => {}),
	} satisfies BackendChildren;
	return { fake, runs, opened };
}

function backendWith(
	fake: ConversationEngine,
	moved: BackendChildren,
	admitAnother?: () => Promise<void>,
	held?: HeldOrder,
) {
	return hostBackend({
		identity: { key: host.key, owner: host.owner },
		host,
		roster,
		engine: fake,
		children: moved,
		...(admitAnother ? { admitAnother } : {}),
		...(held ? { held } : {}),
	});
}

describe("a conversation that moves into a child", () => {
	it("wakes into a child of its own, woken, and the host lets its rest go", async () => {
		const held = entry();
		await roster.hold(held);
		const inHost = engine();
		const moved = children([held.sessionId]);

		await backendWith(inHost, moved.fake).wake(held.sessionId);

		expect(moved.fake.resume).toHaveBeenCalledExactlyOnceWith(held, true);
		expect(inHost.resume).not.toHaveBeenCalled();
		expect(inHost.movedOut).toHaveBeenCalledExactlyOnceWith(held.sessionId);
	});

	it("keeps the host watching its wake when its child ended as it started", async () => {
		const held = entry();
		await roster.hold(held);
		const inHost = engine();
		const moved = children([held.sessionId]);
		// Its child answered and then ended parked, so no route is left.
		moved.fake.resume.mockImplementationOnce(async (resumed) => shown(resumed));

		await backendWith(inHost, moved.fake).wake(held.sessionId);

		expect(moved.fake.resume).toHaveBeenCalledOnce();
		expect(inHost.movedOut).not.toHaveBeenCalled();
	});

	it("keeps the host watching its wake when its child doesn't start", async () => {
		const held = entry();
		await roster.hold(held);
		const inHost = engine();
		const moved = children([held.sessionId]);
		moved.fake.resume.mockRejectedValueOnce(new Error("no child unit"));

		await expect(
			backendWith(inHost, moved.fake).wake(held.sessionId),
		).rejects.toThrow("no child unit");
		expect(inHost.movedOut).not.toHaveBeenCalled();
		expect(inHost.resume).not.toHaveBeenCalled();
	});

	it("waits for the child that last ran it to go before it runs again", async () => {
		const held = entry();
		await roster.hold(held);
		const inHost = engine();
		const moved = children([]);
		let gone: () => void = () => undefined;
		moved.fake.left.mockReturnValueOnce(
			new Promise<void>((done) => {
				gone = done;
			}),
		);

		const woken = backendWith(inHost, moved.fake).wake(held.sessionId);
		await vi.waitFor(() =>
			expect(moved.fake.left).toHaveBeenCalledWith(held.sessionId),
		);
		expect(inHost.resume).not.toHaveBeenCalled();
		gone();
		await woken;

		expect(inHost.resume).toHaveBeenCalledExactlyOnceWith(held, true);
	});

	it("fails a wake, running nothing in the host, while a child still runs it", async () => {
		const held = entry();
		await roster.hold(held);
		const inHost = engine();
		const moved = children([]);
		moved.fake.left.mockRejectedValueOnce(
			new Error(`${held.sessionId} still runs in its unit`),
		);

		await expect(
			backendWith(inHost, moved.fake).wake(held.sessionId),
		).rejects.toThrow("still runs");
		expect(inHost.resume).not.toHaveBeenCalled();
	});

	it("is woken in the host when it hasn't moved, as before", async () => {
		const held = entry();
		await roster.hold(held);
		const inHost = engine();
		const moved = children([]);

		await backendWith(inHost, moved.fake).wake(held.sessionId);

		expect(inHost.resume).toHaveBeenCalledExactlyOnceWith(held, true);
		expect(moved.fake.resume).not.toHaveBeenCalled();
	});

	it("is left alone by a wake while a child runs it", async () => {
		const held = entry();
		await roster.hold(held);
		const inHost = engine();
		const moved = children([held.sessionId]);
		moved.runs.set(held.sessionId, shown(held));

		await backendWith(inHost, moved.fake).wake(held.sessionId);

		expect(moved.fake.resume).not.toHaveBeenCalled();
		expect(inHost.resume).not.toHaveBeenCalled();
	});

	// F174: a close or release waits in the conversation's turn behind the
	// wake, and the wake's child resume waits on a starved child as long
	// as the supervisor does, up to STARVED_WITHIN_MS, 10 minutes, so the
	// end gives that resume up rather than wait it out.
	it.each(["close", "release"] as const)(
		"answers a %s asked while a wake waits on a starved child at once, giving that wake's resume up",
		async (op) => {
			const held = entry();
			await roster.hold(held);
			const moved = children([held.sessionId]);
			let stop: (why: Error) => void = () => undefined;
			moved.fake.resume.mockImplementationOnce(
				() =>
					new Promise<SessionIdentity>((_resolve, reject) => {
						stop = reject;
					}),
			);
			moved.fake.giveUp.mockImplementationOnce((sessionId) =>
				stop(new Error(`${sessionId} was given up`)),
			);
			const backend = backendWith(engine(), moved.fake);
			const waking = backend.wake(held.sessionId);
			const woke = expect(waking).rejects.toThrow("was given up");
			await vi.waitFor(() => expect(moved.fake.resume).toHaveBeenCalled());
			let answered = false;
			const ending = backend
				.execute({ v: 1, id: "e", op, sessionId: held.sessionId })
				.finally(() => {
					answered = true;
				});

			await vi.waitFor(() =>
				expect(answered, "answered without waiting out the wake").toBe(true),
			);
			expect(await ending).toEqual({ sessionId: held.sessionId });
			expect(moved.fake.giveUp).toHaveBeenCalledExactlyOnceWith(held.sessionId);
			await woke;
			expect(roster.entries(), "no longer held").toEqual([]);
		},
	);

	// F24: a wake not yet at its child resume, whether still at the rollout
	// gate or queued behind another wake, has nothing in the supervisor to
	// give up; the end ahead of its turn keeps it from starting a child.
	it("starts no child for a wake still at the rollout gate when an end is asked", async () => {
		const held = entry();
		await roster.hold(held);
		await roster.hold(entry());
		const moved = children([held.sessionId]);
		let admit: (() => void) | undefined;
		const gate = () =>
			new Promise<void>((resolve) => {
				admit = resolve;
			});
		const backend = backendWith(engine(), moved.fake, gate);
		const waking = backend.wake(held.sessionId);
		await vi.waitFor(() => expect(admit).not.toBe(undefined));
		const ending = backend.execute({
			v: 1,
			id: "e",
			op: "close",
			sessionId: held.sessionId,
		});
		admit?.();

		await waking;
		expect(await ending).toEqual({ sessionId: held.sessionId });
		expect(moved.fake.resume, "no child started").not.toHaveBeenCalled();
		expect(
			roster.entries().map(({ sessionId }) => sessionId),
			"no longer held",
		).not.toContain(held.sessionId);
	});

	it("starts no child for a second wake queued ahead of an end", async () => {
		const held = entry();
		await roster.hold(held);
		const moved = children([held.sessionId]);
		let fail: (why: Error) => void = () => undefined;
		moved.fake.resume.mockImplementationOnce(
			() =>
				new Promise<SessionIdentity>((_resolve, reject) => {
					fail = reject;
				}),
		);
		moved.fake.giveUp.mockImplementationOnce(() =>
			fail(new Error("was given up")),
		);
		const backend = backendWith(engine(), moved.fake);
		const first = backend.wake(held.sessionId);
		const firstFailed = expect(first).rejects.toThrow("was given up");
		await vi.waitFor(() => expect(moved.fake.resume).toHaveBeenCalled());
		const second = backend.wake(held.sessionId);
		const ending = backend.execute({
			v: 1,
			id: "e",
			op: "close",
			sessionId: held.sessionId,
		});

		await firstFailed;
		await second;
		expect(await ending).toEqual({ sessionId: held.sessionId });
		expect(
			moved.fake.resume,
			"the second wake started no child",
		).toHaveBeenCalledTimes(1);
		expect(roster.entries(), "no longer held").toEqual([]);
	});

	it("passes the rollout gate before its child starts beside another", async () => {
		const held = entry();
		await roster.hold(held);
		await roster.hold(entry());
		const moved = children([held.sessionId]);
		const stale = new Error("a harness before the census change runs");

		await expect(
			backendWith(engine(), moved.fake, () => Promise.reject(stale)).wake(
				held.sessionId,
			),
		).rejects.toThrow(stale.message);
		expect(moved.fake.resume).not.toHaveBeenCalled();
	});

	it("answers a window's attach once the child it woke into has it", async () => {
		const held = entry();
		await roster.hold(held);
		const moved = children([held.sessionId]);

		const attached = await backendWith(engine(), moved.fake).execute({
			v: 1,
			id: "a",
			op: "attach",
			sessionId: held.sessionId,
			rows: 24,
			columns: 80,
		});

		expect(attached).toEqual({ sessionId: held.sessionId });
		expect(moved.fake.resume).toHaveBeenCalledExactlyOnceWith(held, true);
	});
});

describe("a request that reached the host before the child's route did", () => {
	it("closes in the child that now runs it, which drops it", async () => {
		const held = entry();
		await roster.hold(held);
		const moved = children([held.sessionId]);
		moved.runs.set(held.sessionId, shown(held));
		const close = {
			v: 1,
			id: "c",
			op: "close",
			sessionId: held.sessionId,
			by: "the launcher",
		} as const;

		const closed = await backendWith(engine(), moved.fake).execute(close);

		expect(closed).toEqual({ sessionId: held.sessionId, asked: "the child" });
		expect(moved.fake.ask).toHaveBeenCalledExactlyOnceWith(
			held.sessionId,
			close,
		);
		expect(roster.entries().map(({ sessionId }) => sessionId)).toEqual([
			held.sessionId,
		]);
	});

	it("aborts in the child that now runs it", async () => {
		const held = entry();
		await roster.hold(held);
		const inHost = engine();
		const moved = children([held.sessionId]);
		moved.runs.set(held.sessionId, shown(held));
		const abort = {
			v: 1,
			id: "x",
			op: "abort",
			sessionId: held.sessionId,
		} as const;

		await backendWith(inHost, moved.fake).execute(abort);

		expect(moved.fake.ask).toHaveBeenCalledExactlyOnceWith(
			held.sessionId,
			abort,
		);
		expect(inHost.abort).not.toHaveBeenCalled();
	});
});

describe("a start's resume of what the host held", () => {
	// F23 on #2080: the wake waits on the start's own resume, so the hurry
	// it gives as it resumes could never reach a start still at the gate.
	it("hurries the start's own resume of one a wake asks for while it waits", async () => {
		const waiting = entry();
		await roster.hold(waiting);
		const moved = children([waiting.sessionId]);
		const hurry = vi.fn((_sessionId: string) => {});
		let go = (): void => undefined;
		const atTheGate = new Promise<void>((resolve) => {
			go = resolve;
		});
		moved.fake.resume.mockImplementationOnce(async (held: RosterEntry) => {
			await atTheGate;
			moved.runs.set(held.sessionId, shown(held));
			return shown(held);
		});
		const order = heldOrder(roster);
		const backend = backendWith(
			engine(),
			{ ...moved.fake, hurry },
			undefined,
			order,
		);
		const started = resumeHeld({
			roster,
			engine: engine(),
			children: moved.fake,
			order,
		});
		await vi.waitFor(() => expect(moved.fake.resume).toHaveBeenCalledTimes(1));

		const woke = backend.wake(waiting.sessionId);
		await vi.waitFor(() =>
			expect(hurry, "hurried while it waits").toHaveBeenCalledWith(
				waiting.sessionId,
			),
		);
		go();
		await Promise.all([woke, started]);
		expect(
			moved.fake.resume,
			"resumed once, by the start",
		).toHaveBeenCalledTimes(1);
	});

	it("counts a moved one whose child doesn't start as not resumed", async () => {
		const moving = entry();
		await roster.hold(moving);
		const moved = children([moving.sessionId]);
		const refused = new Error("no child unit");
		moved.fake.resume.mockRejectedValueOnce(refused);

		const { unresumed, resumed } = await resumeHeld({
			roster,
			engine: engine(),
			children: moved.fake,
		});

		expect(unresumed).toEqual([
			{ sessionId: moving.sessionId, reason: refused },
		]);
		expect(resumed).toEqual([]);
	});

	it("takes up a moved one in its child, and leaves one a child already runs", async () => {
		const moving = entry();
		const running = entry();
		const staying = entry();
		for (const held of [moving, running, staying]) await roster.hold(held);
		const inHost = engine();
		const moved = children([moving.sessionId, running.sessionId]);
		moved.runs.set(running.sessionId, shown(running));

		const { resumed } = await resumeHeld({
			roster,
			engine: inHost,
			children: moved.fake,
		});

		expect(
			moved.fake.resume,
			"bounded, as every resume of a start is",
		).toHaveBeenCalledExactlyOnceWith(moving, false, true);
		expect(inHost.resume).toHaveBeenCalledOnce();
		expect(inHost.resume).toHaveBeenCalledWith(
			staying,
			false,
			expect.anything(),
		);
		expect([...resumed].sort()).toEqual(
			[moving, running, staying].map(({ sessionId }) => sessionId).sort(),
		);
	});

	it("resumes one that no longer moves in the host only once no child runs it", async () => {
		const staying = entry();
		await roster.hold(staying);
		const inHost = engine();
		const moved = children([]);
		const still = new Error(`${staying.sessionId} still runs in its unit`);
		moved.fake.left.mockRejectedValueOnce(still);

		const { unresumed } = await resumeHeld({
			roster,
			engine: inHost,
			children: moved.fake,
		});

		expect(moved.fake.left).toHaveBeenCalledWith(staying.sessionId);
		expect(inHost.resume, "never beside its child").not.toHaveBeenCalled();
		expect(unresumed).toEqual([
			{ sessionId: staying.sessionId, reason: still },
		]);
	});

	it.each([
		["became another", (id: string) => roster.replace(id, entry())],
		["closed", (id: string) => roster.drop(id)],
	])("passes over one whose child %s while it waited", async (_, gone) => {
		const staying = entry();
		await roster.hold(staying);
		const inHost = engine();
		const moved = children([]);
		// The child's write lands while the host waits to run it.
		moved.fake.left.mockImplementationOnce(async () => {
			await gone(staying.sessionId);
		});
		const ends: string[] = [];

		const { unresumed, resumed } = await resumeHeld({
			roster,
			engine: inHost,
			children: moved.fake,
			finished: (_step, end) => ends.push(end),
		});

		expect(
			inHost.resume,
			"never what the roster no longer holds",
		).not.toHaveBeenCalled();
		expect(unresumed).toEqual([]);
		expect(resumed, "nothing resumed it").toEqual([]);
		expect(ends).toEqual(["gone"]);
	});

	it("resumes one a wake pulled forward in the wake itself, unbounded, once the start's bounded resume gave it up", async () => {
		const first = entry();
		const woken = entry();
		for (const held of [first, woken]) await roster.hold(held);
		const inHost = engine();
		const moved = children([woken.sessionId]);
		const starved = new Error("its unit did not listen within 60000 ms");
		moved.fake.resume.mockRejectedValueOnce(starved);
		const order = heldOrder(roster);
		const backend = backendWith(inHost, moved.fake, undefined, order);

		const waking = backend.wake(woken.sessionId);
		const { unresumed } = await resumeHeld({
			roster,
			engine: inHost,
			children: moved.fake,
			order,
		});
		await waking;

		expect(unresumed).toEqual([
			{ sessionId: woken.sessionId, reason: starved },
		]);
		expect(
			moved.fake.resume.mock.calls,
			"the start's own first, bounded, then the wake's",
		).toEqual([
			[woken, false, true],
			[woken, true],
		]);
		expect(moved.fake.running(woken.sessionId), "its child runs it").toEqual(
			shown(woken),
		);
		expect(
			moved.fake.resume.mock.invocationCallOrder[0] ?? 0,
			"pulled ahead of the one held before it",
		).toBeLessThan(vi.mocked(inHost.resume).mock.invocationCallOrder[0] ?? 0);
		expect(inHost.resume, "the start went on to the next").toHaveBeenCalledWith(
			first,
			false,
			expect.anything(),
		);
	});

	it("leaves a moved one resting parked, for its wake to start its child", async () => {
		const moving = entry();
		await roster.hold(moving);
		const inHost = { ...engine(), restsParked: vi.fn(() => true) };
		const moved = children([moving.sessionId]);

		const { parked } = await resumeHeld({
			roster,
			engine: inHost,
			children: moved.fake,
		});

		expect(parked).toEqual([moving.sessionId]);
		expect(moved.fake.resume).not.toHaveBeenCalled();
	});
});

describe("a conversation opened while children open", () => {
	const open = {
		v: 1,
		id: "o",
		op: "open",
		cwd: "/work",
		attended: false,
	} as const;

	it("starts in a child, answering what the child answered", async () => {
		const inHost = engine();
		const moved = children([], true);

		const opened = await backendWith(inHost, moved.fake).execute(open);

		expect(opened).toEqual(shown(moved.opened));
		expect(moved.fake.begin).toHaveBeenCalledExactlyOnceWith(
			open,
			expect.any(Number),
		);
		expect(inHost.prepare).not.toHaveBeenCalled();
	});

	// 23 November (ff6ecdd4): a census slow beside many children took its
	// time out of the caller's 120 s, not the begin's 100 s, so a spawn
	// gave up on an open its host still ran.
	it("counts its begin's time from when the host took it, before the rollout gate", async () => {
		await roster.hold(entry());
		const moved = children([], true);
		const took = Date.parse("2026-11-23T05:00:00.000Z");
		const censusTakes = 30_000;
		vi.useFakeTimers({ toFake: ["Date"], now: took });
		const slowCensus = vi.fn(async () => {
			vi.setSystemTime(took + censusTakes);
		});
		try {
			await backendWith(engine(), moved.fake, slowCensus).execute(open);
		} finally {
			vi.useRealTimers();
		}

		expect(slowCensus, "the census ran first").toHaveBeenCalledOnce();
		expect(moved.fake.begin).toHaveBeenCalledExactlyOnceWith(open, took);
	});

	it("passes the rollout gate beside another", async () => {
		await roster.hold(entry());
		const moved = children([], true);
		const gate = vi.fn(async () => {});

		await backendWith(engine(), moved.fake, gate).execute(open);

		expect(gate).toHaveBeenCalledOnce();
	});

	it("adopts in a child too", async () => {
		const moved = children([], true);
		const adopt = {
			v: 1,
			id: "d",
			op: "adopt",
			sessionFile: join(dir, "elsewhere.jsonl"),
			attended: true,
			env: {},
		} as const;

		await backendWith(engine(), moved.fake).execute(adopt);

		expect(moved.fake.begin).toHaveBeenCalledExactlyOnceWith(
			adopt,
			expect.any(Number),
		);
	});

	it("refuses to adopt a file the host already holds, starting no child", async () => {
		const held = entry();
		await roster.hold(held);
		const moved = children([], true);

		const reply = await dispatchControl(
			{
				v: 1,
				id: "d",
				op: "adopt",
				sessionFile: held.file,
				attended: true,
			},
			backendWith(engine(), moved.fake),
		);

		expect(reply).toMatchObject({
			ok: false,
			error: { message: expect.stringContaining("already held") },
		});
		expect(moved.fake.begin).not.toHaveBeenCalled();
	});

	it("fails when its child can't start, as an open in the host would", async () => {
		const moved = children([], true);
		moved.fake.begin.mockRejectedValueOnce(
			new Error("The child's process ended before it listened"),
		);

		const reply = await dispatchControl(
			open,
			backendWith(engine(), moved.fake),
		);

		expect(reply).toMatchObject({ ok: false });
		expect(roster.entries()).toEqual([]);
	});

	it("is refused with the child's own refusal", async () => {
		const moved = children([], true);
		moved.fake.begin.mockResolvedValueOnce({
			v: 1,
			id: "o",
			ok: false,
			error: { code: "untrusted_folder", message: "Trust /work first" },
		});

		const reply = await dispatchControl(
			open,
			backendWith(engine(), moved.fake),
		);

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "untrusted_folder", message: "Trust /work first" },
		});
	});

	// Only the host may say a child runs a conversation all the same, since
	// its caller attaches to the one named; a child saying so of itself was
	// stopped, so its refusal is a plain failure, and its repeat begins anew.
	it("takes a child's own open_unsettled as a failure to open, in the host's words", async () => {
		const moved = children([], true);
		const named = randomUUID();
		const said = {
			code: OPEN_UNSETTLED,
			message: unsettledMessage(named),
		};
		moved.fake.begin.mockImplementation(async (request) => ({
			v: 1,
			id: request.id,
			ok: false,
			error: said,
		}));
		const backend = backendWith(engine(), moved.fake);

		const reply = await dispatchControl(open, backend);
		await dispatchControl({ ...open }, backend);

		expect(reply).toMatchObject({
			ok: false,
			error: { code: "operation_failed", message: CHILD_SAID_UNSETTLED },
		});
		const message = reply.ok ? "" : reply.error.message;
		expect(message, "names nothing to attach to").not.toContain(named);
		expect(
			moved.fake.begin,
			"no conversation stands for it",
		).toHaveBeenCalledTimes(2);
	});

	// A begin the host refused before any child started leaves nothing
	// standing, so its repeat is begun again, not told the refusal.
	it("passes a begin refused as too late on as it is, and begins its repeat anew", async () => {
		const moved = children([], true);
		moved.fake.begin.mockImplementation(async (request) =>
			beganTooLate(request.id, 95_000, 100_000),
		);
		const backend = backendWith(engine(), moved.fake);

		const reply = await dispatchControl(open, backend);
		await dispatchControl({ ...open }, backend);

		expect(reply).toMatchObject({
			ok: false,
			error: { code: BEGIN_TOO_LATE },
		});
		const message = reply.ok ? "" : reply.error.message;
		expect(message).toContain("spent 95 s of its 100 s");
		expect(message).toContain("once the machine is quieter");
		expect(moved.fake.begin, "its repeat begun anew").toHaveBeenCalledTimes(2);
	});
});
