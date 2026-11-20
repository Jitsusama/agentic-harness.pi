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
import type { SessionIdentity } from "../../../host/service/protocol.ts";
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
		expect(moved.fake.begin).toHaveBeenCalledExactlyOnceWith(open);
		expect(inHost.prepare).not.toHaveBeenCalled();
	});

	it("passes the rollout gate beside another", async () => {
		await roster.hold(entry());
		const moved = children([], true);
		const gate = vi.fn(async () => {});

		await backendWith(engine(), moved.fake, gate).execute(open);

		expect(gate).toHaveBeenCalledOnce();
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
