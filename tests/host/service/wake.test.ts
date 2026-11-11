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
import type { AdmitAnother } from "../../../host/service/rollout.ts";
import { type HostRoster, openRoster } from "../../../host/service/roster.ts";
import { until } from "../../support/until.ts";

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
	admitAnother?: AdmitAnother,
	say?: (line: string) => void,
) {
	return hostBackend({
		identity: { key: host.key, owner: host.owner },
		host,
		roster,
		engine: fake,
		...(admitAnother ? { admitAnother } : {}),
		...(say ? { say } : {}),
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
			"two wakes at once resume it once, as a wake",
		).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ sessionId }),
			true,
		);
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
		).toHaveBeenCalledWith(
			sessionId,
			"released, asked by the cutover over the control socket",
		);
		expect(host.holds(sessionId), "it stays closed").toBeUndefined();
	});

	it("closes one released while it parks as a parked one, saying the end before telling its screen", async () => {
		const said: string[] = [];
		let parking: Promise<void> | undefined;
		const fake = engine({
			parkSettled: () => parking ?? Promise.resolve(),
			dropped: vi.fn(async () => {
				said.push("dropped");
			}),
		});
		const backend = backendWith(fake, undefined, (line) => said.push(line));
		const { sessionId } = parseOpenResult(await backend.execute(open));

		parking = host.stop(sessionId, "parked while idle");
		await backend.execute({
			v: 1,
			id: "r",
			op: "release",
			sessionId,
			by: "the cutover",
		});

		expect(
			fake.dropped,
			"its kept screen was let go, told it was released",
		).toHaveBeenCalledWith(
			sessionId,
			"released, asked by the cutover over the control socket",
		);
		expect(said, "the end was said, then its screen told").toEqual([
			expect.stringContaining(
				"ended: released, asked by the cutover over the control socket, held but not running",
			),
			"dropped",
		]);
		expect(
			roster.entries().map((held) => held.sessionId),
			"the roster let it go",
		).not.toContain(sessionId);
	});

	it("says a wake of one whose start failed can't, and that a close lets it go", async () => {
		const fake = engine();
		const backend = backendWith(fake);
		const { sessionId } = parseOpenResult(await backend.execute(open));
		host.state(sessionId, "parked");

		await expect(
			backend.wake(sessionId),
			"the wake says why it can't",
		).rejects.toThrow(/failed as it started; close it and open it again/);
		expect(fake.resume, "nothing resumed").not.toHaveBeenCalled();
	});

	it("waits out every wake under way before saying it settled", async () => {
		let resumed: (() => void) | undefined;
		const waking = new Promise<void>((resolve) => {
			resumed = resolve;
		});
		const fake = engine({
			resume: vi.fn(async (entry) => {
				await waking;
				register(entry);
			}),
		});
		const backend = backendWith(fake);
		const sessionId = await parked(backend);
		let settled = false;

		const woke = backend.wake(sessionId);
		const settling = backend.settled().then(() => {
			settled = true;
		});
		await until(
			"the wake to resume it",
			() => vi.mocked(fake.resume).mock.calls.length > 0,
		);
		expect(settled, "unsettled while the wake resumes").toBe(false);
		resumed?.();
		await woke;
		await settling;

		expect(host.holds(sessionId), "settled once it runs").toBe("idle");
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

		expect(
			gate,
			"the wake asked the gate, as a wake",
		).toHaveBeenCalledExactlyOnceWith("wake");
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
