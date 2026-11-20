/** A conversation that holds its thread holds no other, once each runs in a child. */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { controlRequest } from "../../../host/service/client.ts";
import { jsonLines } from "../../../host/service/framing.ts";

const service = resolve(import.meta.dirname, "../../../host/service");
const busy = "a0000000-0000-4000-8000-000000000001";
const other = "b0000000-0000-4000-8000-000000000002";

/**
 * How long the busy conversation holds its thread: as a collection, a
 * synchronous read of its store or a walk of a folder held the shared
 * host's, 5 s or more 623 times in the two days to 19 November.
 */
const HELD_MS = 3_000;
/** How soon every other conversation, and the host, still answer. */
const ANSWERS_WITHIN_MS = 1_000;

/**
 * One program for the host and its children, each a process of its own.
 * Whichever runs the busy conversation holds its thread through an abort
 * of it for HELD_MS, saying so on stdout as it starts: a child, when the
 * host passes the conversation on, else the host itself, as every
 * conversation ran on the host's one thread before children. A window
 * attaching to a conversation is sent a frame as soon as it attaches.
 */
const source = `
const { listenControl } = await import(${JSON.stringify(join(service, "server.ts"))});
const { heldChildren } = await import(${JSON.stringify(join(service, "children.ts"))});
const held = Number(process.env.HELD_MS);
const identity = JSON.parse(process.env.IDENTITY);
const routes = heldChildren();
for (const [sessionId, route] of JSON.parse(process.env.ROUTES ?? "[]"))
	routes.hold({ sessionId, file: "/x", cwd: "/x", state: "idle", since: "2026-11-19T20:00:00.000Z" }, route);
await listenControl({
	path: process.env.SOCKET,
	report: (error) => console.error(error),
	children: routes,
	viewer: {
		attach(_request, sink) {
			setImmediate(() => sink.write("drawn"));
			return { input() {}, resize() {}, detach() {} };
		},
	},
	backend: {
		identity,
		execute: async (request) => {
			if (request.op === "list") return { sessions: [], host: identity };
			if (request.op === "abort" && request.sessionId === process.env.BUSY) {
				process.stdout.write("holding\\n");
				const until = Date.now() + held;
				while (Date.now() < until) {}
			}
			return { sessionId: request.sessionId };
		},
	},
});
process.stdout.write("listening\\n");
setInterval(() => {}, 1000);`;

let dir: string;
let started: ChildProcess[];
let said: Promise<void>[];
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "threads-"));
	started = [];
	said = [];
});
afterEach(async () => {
	for (const process of started) process.kill("SIGKILL");
	await rm(dir, { recursive: true, force: true });
});

interface Identity {
	key: string;
	owner: { pid: number; startedAt: number };
}

/** Start one, settling once it listens; what it holds goes to `said`. */
async function run(name: string, env: Record<string, string>) {
	const socket = join(dir, `${name}.sock`);
	const identity: Identity = {
		key: "work-background",
		owner: { pid: process.pid, startedAt: started.length + 1 },
	};
	const one = spawn(
		process.execPath,
		["--no-warnings", "--input-type=module", "-e", source],
		{
			env: {
				PATH: process.env.PATH ?? "",
				SOCKET: socket,
				HELD_MS: String(HELD_MS),
				BUSY: busy,
				IDENTITY: JSON.stringify(identity),
				...env,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	started.push(one);
	let out = "";
	let errors = "";
	one.stderr?.on("data", (chunk) => {
		errors += String(chunk);
	});
	const line = (what: string) =>
		new Promise<void>((done, fail) => {
			one.stdout?.on("data", () => {
				if (out.includes(`${what}\n`)) done();
			});
			one.once("exit", (code) =>
				fail(new Error(`${name} exited ${code}: ${errors}`)),
			);
		});
	one.stdout?.on("data", (chunk) => {
		out += String(chunk);
	});
	said.push(line("holding"));
	await line("listening");
	return { socket, identity };
}

/** How long a request to the host takes to be answered, in milliseconds. */
async function answered(
	path: string,
	host: Identity,
	sessionId?: string,
): Promise<number> {
	const asked = Date.now();
	const reply = await controlRequest(
		path,
		sessionId
			? { v: 1, id: "abort", op: "abort", sessionId, expectedHost: host }
			: { v: 1, id: "list", op: "list" },
	);
	if (!reply.ok) throw new Error(reply.error.message);
	return Date.now() - asked;
}

/** How long a window attaching to a conversation waits for its first frame, in milliseconds. */
function drawn(path: string, sessionId: string): Promise<number> {
	const asked = Date.now();
	return new Promise((done, fail) => {
		const window = createConnection(path);
		const frames = jsonLines();
		window.on("data", (chunk: Buffer) => {
			for (const value of frames.push(chunk)) {
				if (Reflect.get(new Object(value), "type") !== "output") continue;
				window.destroy();
				done(Date.now() - asked);
			}
		});
		window.on("error", fail);
		window.write(
			`${JSON.stringify({ v: 1, id: "view", op: "attach", sessionId, rows: 20, columns: 80 })}\n`,
		);
	});
}

describe("a conversation holding its thread", () => {
	it("holds neither the host, another conversation's turn nor a window on it", async () => {
		const [held, free] = await Promise.all([run("busy", {}), run("other", {})]);
		const host = await run("host", {
			ROUTES: JSON.stringify([
				[busy, held],
				[other, free],
			]),
		});

		const holding = answered(host.socket, host.identity, busy);
		await Promise.race(said);
		const [listed, conversation, window] = await Promise.all([
			answered(host.socket, host.identity),
			answered(host.socket, host.identity, other),
			drawn(host.socket, other),
		]);

		expect(listed, "the host answers a list").toBeLessThan(ANSWERS_WITHIN_MS);
		expect(conversation, "another conversation takes a turn").toBeLessThan(
			ANSWERS_WITHIN_MS,
		);
		expect(window, "a window on another conversation draws").toBeLessThan(
			ANSWERS_WITHIN_MS,
		);
		expect(await holding, "the busy one answers once free").toBeGreaterThan(
			ANSWERS_WITHIN_MS,
		);
	}, 20_000);
});
