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
import { spawnInHost } from "../../../extensions/quest-workflow/verbs/spawn-host.ts";
import { SessionHost } from "../../../host/engine/index.ts";
import { hostSocketPath } from "../../../host/service/address.ts";
import {
	type BackendChildren,
	type ConversationEngine,
	hostBackend,
	type Prepared,
} from "../../../host/service/backend.ts";
import { controlRequest } from "../../../host/service/client.ts";
import {
	type ControlReply,
	dispatchControl,
} from "../../../host/service/dispatch.ts";
import { parseOpenResult } from "../../../host/service/protocol.ts";
import { type HostRoster, openRoster } from "../../../host/service/roster.ts";
import { listenControl } from "../../../host/service/server.ts";

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
			// An adopt keeps the file it names, as the engine's does.
			file:
				request.op === "adopt"
					? request.sessionFile
					: join(dir, `${randomUUID()}.jsonl`),
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

function backendWith(
	fake: ConversationEngine,
	children?: BackendChildren,
	say?: (line: string) => void,
) {
	return hostBackend({
		identity: { key: host.key, owner: host.owner },
		host,
		roster,
		engine: fake,
		...(children ? { children } : {}),
		...(say ? { say } : {}),
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
		const lines: string[] = [];
		const backend = backendWith(fake, undefined, (line) => lines.push(line));
		const first = backend.execute(open);
		// The first is loading, not merely asked, when its repeat comes.
		await vi.waitFor(() => expect(fake.start).toHaveBeenCalledOnce());
		const again = backend.execute({ ...open });
		loaded();
		const [opened, repeated] = (await Promise.all([first, again])).map(
			parseOpenResult,
		);
		expect(repeated?.sessionId).toBe(opened?.sessionId);
		expect(fake.prepare).toHaveBeenCalledOnce();
		expect(roster.entries()).toHaveLength(1);
		expect(lines).toContain(
			`Request ${open.id} was asked again while its start was under way; it joins that start`,
		);
	});

	it("answers a repeat sent once the first has opened without opening another, and says so", async () => {
		const { fake, loaded } = slowEngine();
		loaded();
		const lines: string[] = [];
		const backend = backendWith(fake, undefined, (line) => lines.push(line));
		const opened = parseOpenResult(await backend.execute(open));
		const repeated = parseOpenResult(await backend.execute({ ...open }));
		expect(repeated.sessionId).toBe(opened.sessionId);
		expect(fake.prepare).toHaveBeenCalledOnce();
		expect(lines).toContain(
			`Request ${open.id} was asked again; it gets the answer its first ask got`,
		);
	});

	// A repeat of an adopt is the requester's own retry, so it gets the
	// first's answer; another id for the same file is still refused.
	it("answers a repeated adopt with the first's conversation, and refuses the file to another id", async () => {
		const { fake, loaded } = slowEngine();
		loaded();
		const backend = backendWith(fake);
		const adopt = {
			v: 1,
			id: "0196b0e0-0000-7000-8000-000000000002",
			op: "adopt",
			sessionFile: join(dir, "original.jsonl"),
			attended: false,
		} as const;
		const adopted = parseOpenResult(await backend.execute(adopt));
		const repeated = parseOpenResult(await backend.execute({ ...adopt }));
		expect(repeated.sessionId).toBe(adopted.sessionId);
		const reply = await dispatchControl(
			{ ...adopt, id: "0196b0e0-0000-7000-8000-000000000003" },
			backend,
		);
		expect(reply).toMatchObject({
			ok: false,
			error: { code: "already_held" },
		});
		expect(fake.start).toHaveBeenCalledOnce();
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

	// The client's side of IKQ63G through a real socket: its first ask
	// times out while the host still loads, and its retry gets that one.
	it("answers a spawn retried after its answer was lost with the conversation the first opened", async () => {
		const { fake, loaded } = slowEngine();
		const backend = backendWith(fake);
		const runtime = await mkdtemp(join(tmpdir(), "k3-"));
		const listener = await listenControl({
			path: hostSocketPath("work", "background", runtime),
			backend,
			report: () => {},
		});
		try {
			const spawn = {
				kind: "background" as const,
				questId: "QEST-20261108-OSPHT4",
				cwd: dir,
				chosenBy: "the folder the call named",
				env: { MYCELIUM_REALM: "work", XDG_RUNTIME_DIR: runtime },
				pending: join(dir, "pending"),
			};
			const impatient: typeof controlRequest = (socket, request) =>
				controlRequest(socket, request, 300);
			const lost = await spawnInHost(spawn, impatient);
			expect(lost, "the first goes unanswered").toMatchObject({ ok: false });
			loaded();
			const again = await spawnInHost(spawn);
			if (!again.ok) throw new Error(again.guidance);
			expect(fake.prepare).toHaveBeenCalledOnce();
			expect(roster.entries()).toHaveLength(1);
			expect(again.details?.sessionId).toBe(roster.entries()[0]?.sessionId);
		} finally {
			await listener.close();
			await rm(runtime, { recursive: true, force: true });
		}
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
