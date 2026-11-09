/** A host's life: refuse before listening, resume what it holds, keep holds on stop. */
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHost } from "../../../host/engine/index.ts";
import type { ConversationEngine } from "../../../host/service/backend.ts";
import { controlRequest } from "../../../host/service/client.ts";
import {
	parseListResult,
	parseOpenResult,
} from "../../../host/service/protocol.ts";
import { serveHost } from "../../../host/service/serve.ts";
import { heldSessionStatus } from "../../../lib/core/session/roster.ts";

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
	};
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

	it("keeps every hold across stop and resumes them at the next start", async () => {
		const first = await serveHost({
			...places(),
			engine: async (h) => engine(h),
		});
		const ids: string[] = [];
		for (const id of ["a", "b"]) {
			const reply = await controlRequest(first.path, {
				v: 1,
				id,
				op: "open",
				cwd: "/work",
				attended: true,
			});
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
		} finally {
			await second.stop();
		}
	});
});
