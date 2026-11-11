/** The service wakes a parked conversation as it resumes one: in turn with a close of it, and through the rollout gate. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionHost } from "../../../host/engine/index.ts";
import {
	type ConversationEngine,
	hostBackend,
} from "../../../host/service/backend.ts";
import { parseOpenResult } from "../../../host/service/protocol.ts";
import { type HostRoster, openRoster } from "../../../host/service/roster.ts";

const KEY = "work-attended";
const owner = { pid: process.pid, startedAt: 1 };

let dir: string;
let host: SessionHost;
let roster: HostRoster;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wake-"));
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

function register(conversation: {
	sessionId: string;
	file: string;
	cwd: string;
}) {
	host.register({
		id: conversation.sessionId,
		file: conversation.file,
		cwd: conversation.cwd,
		env: {},
		close: () => {},
	});
}

/** An engine registering with the real SessionHost, as the engine does. */
function engine(overrides: Partial<ConversationEngine> = {}) {
	const fake: ConversationEngine = {
		prepare: vi.fn(async () => ({
			sessionId: randomUUID(),
			file: join(dir, `${randomUUID()}.jsonl`),
			cwd: "/work",
		})),
		start: vi.fn(async (prepared) => register(prepared)),
		discard: vi.fn(async () => {}),
		resume: vi.fn(async (entry) => register(entry)),
		abort: vi.fn(async () => {}),
		dropped: vi.fn(async () => {}),
		...overrides,
	};
	return fake;
}

function backendWith(
	fake: ConversationEngine,
	admitAnother?: () => Promise<void>,
) {
	return hostBackend({
		identity: { key: host.key, owner: host.owner },
		host,
		roster,
		engine: fake,
		...(admitAnother ? { admitAnother } : {}),
	});
}

const open = {
	v: 1,
	id: "o",
	op: "open",
	cwd: "/work",
	attended: true,
} as const;

/** Open a conversation, then park it as the engine does: a host stop, keeping its hold. */
async function parked(backend: ReturnType<typeof backendWith>) {
	const { sessionId } = parseOpenResult(await backend.execute(open));
	await host.stop(sessionId, "parked while idle");
	return sessionId;
}

describe("waking a parked conversation", () => {
	it("resumes it once, leaving one already awake alone", async () => {
		const fake = engine();
		const backend = backendWith(fake);
		const sessionId = await parked(backend);

		await Promise.all([backend.wake(sessionId), backend.wake(sessionId)]);

		expect(
			fake.resume,
			"two wakes at once resume it once",
		).toHaveBeenCalledOnce();
		expect(host.holds(sessionId), "it runs again").toBe("idle");
	});

	it("leaves one released while it slept gone, telling its screen why, even with the wake asked first", async () => {
		const fake = engine();
		const backend = backendWith(fake);
		const sessionId = await parked(backend);

		const closing = backend.execute({
			v: 1,
			id: "c",
			op: "release",
			sessionId,
			by: "the cutover",
		});
		const waking = backend.wake(sessionId);
		await Promise.all([closing, waking]);

		expect(
			fake.resume,
			"the wake asked in the close's turn finds it gone",
		).not.toHaveBeenCalled();
		expect(
			fake.dropped,
			"its kept screen was let go, told it was released",
		).toHaveBeenCalledWith(sessionId, "released, asked by the cutover");
		expect(host.holds(sessionId), "it stays closed").toBeUndefined();
	});

	it("goes through the rollout gate beside another conversation, and stays parked when refused", async () => {
		const fake = engine();
		const refused = new Error("pid 41 runs a harness before the census change");
		const gate = vi.fn(() => Promise.reject(refused));
		const backend = backendWith(fake, gate);
		const sessionId = await parked(backend);
		// The first open passes without asking; a second would ask.
		gate.mockClear();
		await backendWith(engine()).execute(open);

		await expect(backend.wake(sessionId)).rejects.toBe(refused);

		expect(gate, "the wake asked the gate").toHaveBeenCalledOnce();
		expect(
			fake.resume,
			"a refused wake resumes nothing",
		).not.toHaveBeenCalled();
		expect(
			roster.entries().map((held) => held.sessionId),
			"it stays held, parked",
		).toContain(sessionId);
	});

	it("wakes it as a window attaches, then answers its identity", async () => {
		const fake = engine();
		const backend = backendWith(fake);
		const sessionId = await parked(backend);

		await expect(
			backend.execute({
				v: 1,
				id: "t",
				op: "attach",
				sessionId,
				rows: 40,
				columns: 120,
			}),
		).resolves.toEqual({ sessionId });

		expect(fake.resume, "the attach woke it").toHaveBeenCalledOnce();
		expect(host.holds(sessionId), "it runs for the window").toBe("idle");
	});
});
