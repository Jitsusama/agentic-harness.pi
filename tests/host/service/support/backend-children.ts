/** A backend over a real host and roster, with fake children that run what moves, for the backend-children tests. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { SessionHost } from "../../../../host/engine/index.ts";
import {
	type BackendChildren,
	type ConversationEngine,
	hostBackend,
} from "../../../../host/service/backend.ts";
import type { ControlReply } from "../../../../host/service/dispatch.ts";
import type {
	ControlRequest,
	SessionIdentity,
} from "../../../../host/service/protocol.ts";
import type { HeldOrder } from "../../../../host/service/resume-held.ts";
import {
	type HostRoster,
	openRoster,
} from "../../../../host/service/roster.ts";
import type { RosterEntry } from "../../../../lib/core/session/roster.ts";

const KEY = "work-background";
const owner = { pid: process.pid, startedAt: 1 };

/** This test's folder, made fresh for each test by `useBackendBed`. */
export let dir: string;
/** This test's host, made fresh for each test by `useBackendBed`. */
export let host: SessionHost;
/** This test's roster, made fresh for each test by `useBackendBed`. */
export let roster: HostRoster;

/**
 * Give each test of the file calling it a folder, a host and a roster
 * of its own, read through `dir`, `host` and `roster`, and tear them
 * down after it.
 */
export function useBackendBed(): void {
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
}

/** An engine for the host itself, which registers what it resumes. */
export function engine(): ConversationEngine {
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

/** A roster entry for a conversation in this test's folder. */
export function entry(sessionId = randomUUID()): RosterEntry {
	return {
		sessionId,
		file: join(dir, `${sessionId}.jsonl`),
		cwd: dir,
		attended: false,
		since: "2026-11-20T03:00:00.000Z",
	};
}

/** What a child answers for `held` once it runs it. */
export function shown(held: RosterEntry): SessionIdentity {
	const { sessionId, file, cwd, since } = held;
	return { sessionId, file, cwd, state: "idle", since };
}

/** Children that run what moves, as the supervisor would. */
export function children(moving: readonly string[], opening = false) {
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

/** The backend over this test's host and roster, with `moved` as its children. */
export function backendWith(
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
