/** A host's life: refuse before listening, resume what it holds, keep holds on stop. */
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHost } from "../../../host/engine/index.ts";
import type {
	ConversationEngine,
	ConversationEvents,
} from "../../../host/service/backend.ts";
import { controlRequest } from "../../../host/service/client.ts";
import {
	parseListResult,
	parseOpenResult,
} from "../../../host/service/protocol.ts";
import { serveHost } from "../../../host/service/serve.ts";
import { heldSessionStatus } from "../../../lib/core/session/roster.ts";
import { until } from "../../support/until.ts";

// The net is process-wide, so the worker running these tests keeps its
// own handling; what is checked is that a host sets it, and where.
const { spared } = vi.hoisted(() => ({ spared: vi.fn() }));
vi.mock("../../../lib/internal/reload/stale-rejections.ts", () => ({
	spareStaleRejections: spared,
}));

let dir: string;
let report: ReturnType<typeof vi.fn<(error: unknown) => void>>;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "h2-serve-"));
	report = vi.fn();
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function places() {
	return {
		realm: "work",
		kind: "attended" as const,
		runtimeDir: join(dir, "run"),
		rosterDir: join(dir, "rosters"),
		registryDir: join(dir, "hosts"),
		rejectionLog: join(dir, "stale-rejections.jsonl"),
		report,
		// These hosts run from a tree, so open the rollout gate for them.
		rollout: () => Promise.resolve(),
	};
}

async function opened(path: string, id: string) {
	return controlRequest(path, {
		v: 1,
		id,
		op: "open",
		cwd: "/work",
		attended: true,
	});
}

/** A fake engine over the real SessionHost, as H1's registers. */
function engine(
	host: SessionHost,
	missing = new Set<string>(),
): ConversationEngine {
	const register = (c: { sessionId: string; file: string; cwd: string }) =>
		host.register({
			id: c.sessionId,
			file: c.file,
			cwd: c.cwd,
			env: {},
			close: () => {},
		});
	return {
		prepare: async (request) => ({
			sessionId: randomUUID(),
			file: join(dir, `${randomUUID()}.jsonl`),
			cwd: request.op === "open" ? request.cwd : dir,
		}),
		start: async (prepared) => register(prepared),
		discard: async () => {},
		resume: async (entry) => {
			if (missing.has(entry.sessionId)) throw new Error("session file is gone");
			register(entry);
		},
		abort: async () => {},
		backgroundOf: () => 0,
	};
}

async function listed(path: string) {
	const reply = await controlRequest(path, { v: 1, id: "l", op: "list" });
	if (!reply.ok) throw new Error(reply.error.message);
	return parseListResult(reply.result);
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

describe("serveHost", () => {
	it("refuses a second host of one key before it touches the socket", async () => {
		const first = await serveHost({
			...places(),
			engine: async (h) => engine(h),
		});
		try {
			await expect(
				serveHost({ ...places(), engine: async (h) => engine(h) }),
			).rejects.toThrow("Another host holds this roster");
			expect((await listed(first.path)).host).toEqual(first.identity);
		} finally {
			await first.stop();
		}
	});

	it("refuses to listen on a pi the engine won't run, and frees the lock", async () => {
		const refused = new Error("Host pi lacks pi-host-committed-turn.patch");
		await expect(
			serveHost({
				...places(),
				engine: async () => {
					throw refused;
				},
			}),
		).rejects.toBe(refused);
		expect(
			await exists(join(dir, "run", "pi-host", "work-attended.sock")),
			"a refused host left no socket",
		).toBe(false);
		const next = await serveHost({
			...places(),
			engine: async (h) => engine(h),
		});
		await next.stop();
	});

	it("spares the host stale-context rejections before any conversation", async () => {
		spared.mockClear();
		const host = await serveHost({
			...places(),
			engine: async (h) => {
				expect(spared).toHaveBeenCalledWith(
					join(dir, "stale-rejections.jsonl"),
				);
				return engine(h);
			},
		});
		await host.stop();
		expect(spared).toHaveBeenCalledTimes(1);
	});

	it("keeps to one conversation when run from a tree, by its own rollout gate", async () => {
		const host = await serveHost({
			...places(),
			rollout: undefined,
			engine: async (h) => engine(h),
		});
		try {
			expect(
				(await opened(host.path, "a")).ok,
				"its first conversation is never gated",
			).toBe(true);
			const second = await opened(host.path, "b");
			if (second.ok) throw new Error("a host from a tree opened a second");
			expect(second.error.code).toBe("rollout_refused");
			expect(second.error.message).toContain("outside an installed version");
			expect((await listed(host.path)).sessions).toHaveLength(1);
		} finally {
			await host.stop();
		}
	});

	it.each([
		[
			"tells an attached viewer it restarts as it stops, once a restart is coming",
			true,
		],
		[
			"tells an attached viewer nothing as it stops for any other reason",
			false,
		],
	])("%s", async (_case, coming) => {
		const served = await serveHost({
			...places(),
			engine: async (h) => engine(h),
			viewer: () => ({
				attach: () => ({ input() {}, resize() {}, detach() {} }),
			}),
		});
		const reply = await opened(served.path, "a");
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		const socket = createConnection(served.path);
		let heard = "";
		const attached = new Promise<void>((resolve) =>
			socket.on("data", (chunk) => {
				heard += String(chunk);
				if (heard.includes('"id":"view"')) resolve();
			}),
		);
		const closed = new Promise<void>((resolve) => socket.on("close", resolve));
		socket.write(
			`${JSON.stringify({ v: 1, id: "view", op: "attach", sessionId, rows: 20, columns: 80 })}\n`,
		);
		await attached;

		served.restartComing(coming);
		await served.stop();
		await closed;
		const frames = heard
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(
			frames.some((frame) => frame.type === "restarting"),
			"whether the viewer heard the host is restarting",
		).toBe(coming);
	});

	it("keeps every hold across stop and resumes them at the next start", async () => {
		const first = await serveHost({
			...places(),
			engine: async (h) => engine(h),
		});
		const ids: string[] = [];
		for (const id of ["a", "b"]) {
			const reply = await opened(first.path, id);
			if (!reply.ok) throw new Error(reply.error.message);
			ids.push(parseOpenResult(reply.result).sessionId);
		}
		await first.stop();
		const [kept, gone] = ids as [string, string];
		for (const id of ids)
			expect(await heldSessionStatus(id, { dir: join(dir, "rosters") })).toBe(
				"held",
			);

		const second = await serveHost({
			...places(),
			engine: async (h) => engine(h, new Set([gone])),
		});
		try {
			expect(second.unresumed.map(({ sessionId }) => sessionId)).toEqual([
				gone,
			]);
			expect(report).toHaveBeenCalledWith(new Error("session file is gone"));
			expect(
				(await listed(second.path)).sessions.map(({ sessionId, state }) => [
					sessionId,
					state,
				]),
			).toEqual([
				[kept, "idle"],
				[gone, "parked"],
			]);
			expect(second.stillUnresumed(), "still held, not running").toBe(1);
			const closed = await controlRequest(second.path, {
				v: 1,
				id: "c",
				op: "close",
				sessionId: gone,
				expectedHost: second.identity,
			});
			if (!closed.ok) throw new Error(closed.error.message);
			expect(second.stillUnresumed(), "once it is closed").toBe(0);
			expect(second.unresumed, "what the start found").toHaveLength(1);
		} finally {
			await second.stop();
		}
	});

	it("lets a wake under way finish before a stop parks, so it stays held and stops with the rest", async () => {
		let sessionHost: SessionHost | undefined;
		let events: ConversationEvents | undefined;
		let resumed: (() => void) | undefined;
		const waking = new Promise<void>((resolve) => {
			resumed = resolve;
		});
		let resuming = false;
		const serving = await serveHost({
			...places(),
			engine: async (h) => {
				sessionHost = h;
				const plain = engine(h);
				return {
					...plain,
					watch: (given) => {
						events = given;
					},
					resume: async (entry) => {
						resuming = true;
						await waking;
						await plain.resume(entry);
					},
				};
			},
		});
		const reply = await opened(serving.path, "a");
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		await sessionHost?.stop(sessionId, "parked while idle");

		const woke = events?.wake?.(sessionId);
		await until("the wake to resume it", () => resuming);
		const stopped = serving.stop();
		// Resumed only once the stop has closed its socket, as it would go on
		// to park and dispose the host.
		await until(
			"the stop to close its socket",
			async () => !(await exists(serving.path)),
		);
		resumed?.();
		await expect(
			woke,
			"the wake resumed it in a host not yet disposed",
		).resolves.toBeUndefined();
		await stopped;

		expect(
			sessionHost?.list().map(({ id }) => id),
			"the stop parked what the wake resumed, leaving nothing running",
		).toEqual([]);
		expect(
			await heldSessionStatus(sessionId, { dir: join(dir, "rosters") }),
			"it stays held for the next start",
		).toBe("held");
	});

	it("refuses a wake that comes once the host is stopping, saying the next start takes it up", async () => {
		let sessionHost: SessionHost | undefined;
		let events: ConversationEvents | undefined;
		let resumes = 0;
		const serving = await serveHost({
			...places(),
			engine: async (h) => {
				sessionHost = h;
				const plain = engine(h);
				return {
					...plain,
					watch: (given) => {
						events = given;
					},
					resume: async (entry) => {
						resumes += 1;
						await plain.resume(entry);
					},
				};
			},
		});
		const reply = await opened(serving.path, "a");
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		await sessionHost?.stop(sessionId, "parked while idle");

		const stopped = serving.stop();
		const woke = events?.wake?.(sessionId);

		await expect(
			woke,
			"the wake says why nothing wakes it, so its window can say so",
		).rejects.toThrow(
			"the host is stopping, and takes the conversation up again as it starts",
		);
		await stopped;
		expect(resumes, "nothing resumed in the stopping host").toBe(0);
		expect(
			await heldSessionStatus(sessionId, { dir: join(dir, "rosters") }),
			"it stays held for the next start",
		).toBe("held");
	});

	it("leaves one still parked from before the start parked, waking it once listening for a wake asked as it started", async () => {
		const first = await serveHost({
			...places(),
			engine: async (h) => engine(h),
		});
		const reply = await opened(first.path, "a");
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		await first.stop();

		let events: ConversationEvents | undefined;
		let woke: Promise<void> | undefined;
		const resumes: (boolean | undefined)[] = [];
		const second = await serveHost({
			...places(),
			engine: async (h) => {
				const plain = engine(h);
				return {
					...plain,
					watch: (given) => {
						events = given;
					},
					// A message wrote its wake file while the host was down.
					restsParked: (entry) => {
						woke = events?.wake?.(entry.sessionId);
						return true;
					},
					resume: async (entry, woken) => {
						resumes.push(woken);
						await plain.resume(entry);
					},
				};
			},
		});
		try {
			expect(second.unresumed, "nothing failed to resume").toEqual([]);
			await woke;
			expect(
				resumes,
				"built once, by the wake, rather than by the start",
			).toEqual([true]);
			expect(
				(await listed(second.path)).sessions.map(({ sessionId: id, state }) => [
					id,
					state,
				]),
				"the wake left it running",
			).toEqual([[sessionId, "idle"]]);
		} finally {
			await second.stop();
		}
	});

	it("watches the engine before it resumes, so a conversation that ends inside pi is dropped", async () => {
		const first = await serveHost({
			...places(),
			engine: async (h) => engine(h),
		});
		const reply = await opened(first.path, "a");
		if (!reply.ok) throw new Error(reply.error.message);
		const { sessionId } = parseOpenResult(reply.result);
		await first.stop();

		const order: string[] = [];
		let events: ConversationEvents | undefined;
		const second = await serveHost({
			...places(),
			engine: async (h) => {
				const plain = engine(h);
				return {
					...plain,
					watch: (given) => {
						order.push("watch");
						events = given;
					},
					resume: async (entry) => {
						order.push("resume");
						await plain.resume(entry);
					},
				};
			},
		});
		try {
			expect(order).toEqual(["watch", "resume"]);
			await events?.ended(sessionId, "quit");
			expect(
				await heldSessionStatus(sessionId, { dir: join(dir, "rosters") }),
			).toBe("unheld");
		} finally {
			await second.stop();
		}
	});
});
