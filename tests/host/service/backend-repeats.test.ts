/**
 * The backend answering an open or adopt asked again under its id, as a
 * spawn that timed out asks, with the first one's conversation rather
 * than a second, here or in a child.
 */
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
	type Prepared,
} from "../../../host/service/backend.ts";
import {
	type ControlReply,
	dispatchControl,
} from "../../../host/service/dispatch.ts";
import { parseOpenResult } from "../../../host/service/protocol.ts";
import { type HostRoster, openRoster } from "../../../host/service/roster.ts";

const KEY = "work-background";
const owner = { pid: process.pid, startedAt: 1 };

let dir: string;
let host: SessionHost;
let roster: HostRoster;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "h2-backend-repeats-"));
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

/** An engine whose start waits for the test, as a slow extension load does. */
function slowEngine() {
	let loaded: () => void = () => undefined;
	const loading = new Promise<void>((done) => {
		loaded = done;
	});
	const fake: ConversationEngine = {
		prepare: vi.fn(async (request) => ({
			sessionId: randomUUID(),
			file: join(dir, `${randomUUID()}.jsonl`),
			cwd: request.op === "open" ? request.cwd : dir,
		})),
		start: vi.fn(async (prepared: Prepared) => {
			await loading;
			host.register({
				id: prepared.sessionId,
				file: prepared.file,
				cwd: prepared.cwd,
				env: { PI_SESSION_ID: prepared.sessionId },
				close: () => undefined,
			});
		}),
		discard: vi.fn(async () => {}),
		resume: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
		backgroundOf: () => 0,
	};
	return { fake, loaded };
}

function backendWith(fake: ConversationEngine, children?: BackendChildren) {
	return hostBackend({
		identity: { key: host.key, owner: host.owner },
		host,
		roster,
		engine: fake,
		...(children ? { children } : {}),
		now: () => new Date("2026-11-21T10:00:00.000Z"),
	});
}

const open = {
	v: 1,
	id: "0196b0e0-0000-7000-8000-000000000001",
	op: "open",
	cwd: "/work",
	attended: false,
	quest: "QEST-20261108-OSPHT4",
} as const;

describe("a start asked again under its id", () => {
	// CWUEGJ's retry, sent while the first open still loaded, made a twin
	// of the conversation it opened (IKQ63G, 4ddf93b9).
	it("answers a repeat sent while the first still loads with the first's conversation, holding one", async () => {
		const { fake, loaded } = slowEngine();
		const backend = backendWith(fake);
		const first = backend.execute(open);
		const again = backend.execute({ ...open });
		loaded();
		const [opened, repeated] = (await Promise.all([first, again])).map(
			parseOpenResult,
		);
		expect(repeated?.sessionId).toBe(opened?.sessionId);
		expect(fake.prepare).toHaveBeenCalledOnce();
		expect(roster.entries()).toHaveLength(1);
	});

	it("answers a repeat sent once the first has opened without opening another", async () => {
		const { fake, loaded } = slowEngine();
		loaded();
		const backend = backendWith(fake);
		const opened = parseOpenResult(await backend.execute(open));
		const repeated = parseOpenResult(await backend.execute({ ...open }));
		expect(repeated.sessionId).toBe(opened.sessionId);
		expect(fake.prepare).toHaveBeenCalledOnce();
	});

	it("opens anew on a repeat of an open that failed", async () => {
		const { fake, loaded } = slowEngine();
		loaded();
		vi.mocked(fake.prepare).mockRejectedValueOnce(new Error("no such folder"));
		const backend = backendWith(fake);
		await expect(backend.execute(open)).rejects.toThrow("no such folder");
		parseOpenResult(await backend.execute({ ...open }));
		expect(fake.prepare).toHaveBeenCalledTimes(2);
		expect(roster.entries()).toHaveLength(1);
	});

	it("refuses to the requester an id used again for another open, opening nothing more", async () => {
		const { fake, loaded } = slowEngine();
		loaded();
		const backend = backendWith(fake);
		await backend.execute(open);
		const reply = await dispatchControl(
			{ ...open, cwd: "/elsewhere" },
			backend,
		);
		expect(reply).toMatchObject({
			ok: false,
			error: { code: "id_reused" },
		});
		expect(fake.prepare).toHaveBeenCalledOnce();
	});

	it("asks a child once for a repeat sent while the child still opens", async () => {
		const { fake } = slowEngine();
		let answered: () => void = () => undefined;
		const sessionId = randomUUID();
		const children: BackendChildren = {
			moves: () => false,
			opens: () => true,
			running: () => undefined,
			resume: vi.fn(),
			begin: vi.fn(
				(request) =>
					new Promise<ControlReply>((resolve) => {
						answered = () =>
							resolve({
								v: 1,
								id: request.id,
								ok: true,
								result: {
									sessionId,
									file: join(dir, `${sessionId}.jsonl`),
									cwd: "/work",
									state: "idle",
									since: "2026-11-21T10:00:00.000Z",
								},
							});
					}),
			),
			ask: vi.fn(),
			left: vi.fn(async () => {}),
		};
		const backend = backendWith(fake, children);
		const first = backend.execute(open);
		const again = backend.execute({ ...open });
		answered();
		const [opened, repeated] = (await Promise.all([first, again])).map(
			parseOpenResult,
		);
		expect(repeated?.sessionId).toBe(opened?.sessionId);
		expect(children.begin).toHaveBeenCalledOnce();
		expect(fake.prepare).not.toHaveBeenCalled();
	});
});
