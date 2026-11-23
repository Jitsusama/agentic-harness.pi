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
	type ControlReply,
	dispatchControl,
} from "../../../host/service/dispatch.ts";
import type {
	ControlRequest,
	SessionIdentity,
} from "../../../host/service/protocol.ts";
import { resumeHeld } from "../../../host/service/resume-held.ts";
import { type HostRoster, openRoster } from "../../../host/service/roster.ts";
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
	} satisfies BackendChildren;
	return { fake, runs, opened };
}

function backendWith(
	fake: ConversationEngine,
	moved: BackendChildren,
	admitAnother?: () => Promise<void>,
) {
	return hostBackend({
		identity: { key: host.key, owner: host.owner },
		host,
		roster,
		engine: fake,
		children: moved,
		...(admitAnother ? { admitAnother } : {}),
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
		try {
			const slowCensus = async () => {
				vi.setSystemTime(took + censusTakes);
			};

			await backendWith(engine(), moved.fake, slowCensus).execute(open);
		} finally {
			vi.useRealTimers();
		}

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
});
