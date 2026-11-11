/** A host killed outright comes back with what it held, at the same address. */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHost } from "../../../host/engine/index.ts";
import type { ConversationEngine } from "../../../host/service/backend.ts";
import { controlRequest } from "../../../host/service/client.ts";
import {
	parseListResult,
	parseOpenResult,
} from "../../../host/service/protocol.ts";
import { serveHost } from "../../../host/service/serve.ts";
import { gone } from "../../support/processes.ts";

// The net is process-wide, so the worker keeps its own handling; the
// killed host sets it in its own process, where it belongs.
vi.mock("../../../lib/internal/reload/stale-rejections.ts", () => ({
	spareStaleRejections: vi.fn(),
}));

const serve = resolve(import.meta.dirname, "../../../host/service/serve.ts");

/**
 * The same fake engine both hosts run: a conversation is a registration
 * over the real SessionHost, as H1's engine makes one.
 */
const engineSource = `
const engine = (host, dir) => {
	const register = (c) => host.register({
		id: c.sessionId, file: c.file, cwd: c.cwd, env: {}, close: () => {},
	});
	return {
		prepare: async (request) => ({
			sessionId: crypto.randomUUID(),
			file: dir + "/" + crypto.randomUUID() + ".jsonl",
			cwd: request.op === "open" ? request.cwd : dir,
		}),
		start: async (prepared) => register(prepared),
		discard: async () => {},
		resume: async (entry) => register(entry),
		abort: async () => {},
		backgroundOf: () => 0,
	};
};`;

function engine(host: SessionHost, dir: string): ConversationEngine {
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
		resume: async (entry) => register(entry),
		abort: async () => {},
		backgroundOf: () => 0,
	};
}

let dir: string;
let child: ChildProcess | undefined;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "h2-killed-"));
});
afterEach(async () => {
	child?.kill("SIGKILL");
	child = undefined;
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
	};
}

/** Start a host in a process of its own and wait for it to listen. */
async function hostInAChild(): Promise<{ pid: number; path: string }> {
	const source = `${engineSource}
const { serveHost } = await import(${JSON.stringify(serve)});
const places = JSON.parse(process.env.PLACES);
const host = await serveHost({
	...places,
	rollout: () => Promise.resolve(),
	report: (error) => console.error(error),
	engine: async (h) => engine(h, places.runtimeDir),
});
process.stdout.write(host.path + "\\n");
setInterval(() => {}, 1000);`;
	const started = spawn(
		process.execPath,
		["--no-warnings", "--input-type=module", "-e", source],
		{
			env: { PATH: process.env.PATH ?? "", PLACES: JSON.stringify(places()) },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	child = started;
	let errors = "";
	started.stderr?.on("data", (chunk) => {
		errors += String(chunk);
	});
	const path = await new Promise<string>((done, fail) => {
		let out = "";
		started.stdout?.on("data", (chunk) => {
			out += String(chunk);
			if (out.includes("\n")) done(out.trim());
		});
		started.once("exit", (code) =>
			fail(new Error(`the host exited ${code} before listening: ${errors}`)),
		);
	});
	if (started.pid === undefined) throw new Error("the host never got a pid");
	return { pid: started.pid, path };
}

async function open(path: string, id: string): Promise<string> {
	const reply = await controlRequest(path, {
		v: 1,
		id,
		op: "open",
		cwd: "/work",
		attended: true,
	});
	if (!reply.ok) throw new Error(reply.error.message);
	return parseOpenResult(reply.result).sessionId;
}

describe("a host killed with SIGKILL", () => {
	it("leaves its lock and socket, and the next host takes both and resumes its holds", async () => {
		const killed = await hostInAChild();
		const ids = [await open(killed.path, "a"), await open(killed.path, "b")];

		process.kill(killed.pid, "SIGKILL");
		await gone(killed.pid, 5_000);
		expect(
			(await lstat(killed.path)).isSocket(),
			"a killed host's socket outlives it, as after a crash",
		).toBe(true);

		const report = vi.fn<(error: unknown) => void>();
		const next = await serveHost({
			...places(),
			// Run from a tree, so the rollout gate is opened for it.
			rollout: () => Promise.resolve(),
			report,
			engine: async (h) => engine(h, dir),
		});
		try {
			expect(next.path).toBe(killed.path);
			expect(next.unresumed).toEqual([]);
			const reply = await controlRequest(next.path, {
				v: 1,
				id: "l",
				op: "list",
			});
			if (!reply.ok) throw new Error(reply.error.message);
			const listed = parseListResult(reply.result);
			expect(listed.host.owner.pid).toBe(process.pid);
			expect(
				listed.sessions.map(({ sessionId, state }) => [sessionId, state]),
			).toEqual(ids.map((id) => [id, "idle"]));
			expect(report).not.toHaveBeenCalled();
		} finally {
			await next.stop();
		}
	});
});
