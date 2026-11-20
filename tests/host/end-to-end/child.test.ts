/**
 * A child host as its own process, as a supervisor starts one: its slot
 * file written, then the child made from its environment as its program
 * makes it (childHost) and run, with PI_HOST_CHILD_KEY and
 * PI_HOST_CHILD_SOCKET and systemd's notify socket named, as a unit
 * would name it. The watch answers once the child holds its
 * conversation, and the child ends saying why: closed when its one
 * conversation closes, parked at a stop signal, and in both cases exits
 * 0 having told systemd nothing. Runs on the fake engine, since what is
 * proved here is the child's life, not pi's.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { controlRequest } from "../../../host/service/client.ts";
import { jsonLines } from "../../../host/service/framing.ts";
import {
	parseListResult,
	parseOpenResult,
	parseWatchLine,
	parseWatchResult,
} from "../../../host/service/protocol.ts";
import { type Seal, seal } from "./support/seal.ts";

const FAKE_ENGINE = resolve(import.meta.dirname, "support/fake-engine.ts");
const RUN = resolve(import.meta.dirname, "../../../host/service/run.ts");
const CHILD = resolve(import.meta.dirname, "../../../host/service/child.ts");
const SESSION = "c0000000-0000-4000-8000-000000000003";

/** How long a case may take: a node process's start, an open and a stop, past vitest's 5 s on a loaded machine. */
const CASE_MS = 60_000;
/** How long a child may take to listen. */
const LISTEN_MS = 30_000;

let sealed: Seal;
beforeEach(async () => {
	sealed = await seal();
});
afterEach(async () => {
	await sealed.dispose();
});

/** The child's folder under the seal, its key and a slot's socket. */
function slotOf(name: string) {
	const key = `${sealed.realm}-background`;
	const folder = join(sealed.env.XDG_RUNTIME_DIR ?? "", "pi-host", `${key}.d`);
	return { key, folder, socket: join(folder, `${name}.sock`) };
}

/**
 * Start a child for the slot `name`, whose file holds `given`, and wait
 * until its socket answers a list. Answers the process and its exit.
 */
async function startChild(name: string, given: unknown) {
	const { key, folder, socket } = slotOf(name);
	await mkdir(folder, { recursive: true, mode: 0o700 });
	await writeFile(join(folder, `${name}.json`), JSON.stringify(given));
	const notify = join(sealed.root, "notify.sock");
	const source = `
const { runHost } = await import(${JSON.stringify(RUN)});
const child = await import(${JSON.stringify(CHILD)});
const { engine } = await import(${JSON.stringify(FAKE_ENGINE)});
const started = child.childHost(process.env, "/harness");
const run = await runHost({
	argv: ["--child"],
	env: process.env,
	child: { slot: started.slot, life: started.life },
	engine: (host) => {
		started.hosts(host);
		return engine(host);
	},
});
await run.stopped;
const why = await started.life.ending;
process.stdout.write(JSON.stringify({ why, notify: process.env.NOTIFY_SOCKET ?? null }) + "\\n");
process.exit(why === "failed" ? 1 : 0);`;
	const process_ = spawn(
		process.execPath,
		["--no-warnings", "--input-type=module", "-e", source],
		{
			env: {
				...sealed.env,
				PI_HOST_CHILD_KEY: key,
				PI_HOST_CHILD_SOCKET: socket,
				NOTIFY_SOCKET: notify,
				WATCHDOG_USEC: "120000000",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let out = "";
	let errors = "";
	process_.stdout.on("data", (chunk) => {
		out += String(chunk);
	});
	process_.stderr.on("data", (chunk) => {
		errors += String(chunk);
	});
	const exited = new Promise<number | null>((done) =>
		process_.once("exit", (code) => done(code)),
	);
	const began = Date.now();
	for (;;) {
		try {
			parseListResult(resultOf(await controlRequest(socket, list())));
			break;
		} catch (error) {
			if (Date.now() - began > LISTEN_MS)
				throw new Error(`the child never listened: ${errors}`, {
					cause: error,
				});
			await new Promise((done) => {
				// The child is still starting; look again shortly.
				setTimeout(done, 100);
			});
		}
	}
	return {
		socket,
		process: process_,
		exited,
		said: () => out,
		errors: () => errors,
	};
}

/** The result a watch's first line carries, or nothing. */
function resultIn(line: unknown): unknown {
	return typeof line === "object" && line !== null
		? Reflect.get(line, "result")
		: undefined;
}

/** What a request answered, or a throw saying why it was refused. */
function resultOf(answer: Awaited<ReturnType<typeof controlRequest>>): unknown {
	if (!answer.ok) throw new Error(answer.error.message);
	return answer.result;
}

let asked = 0;
function list() {
	return { v: 1 as const, id: `l${++asked}`, op: "list" as const };
}

/** A watch on `socket`: its answer, then each line it sends to its ending. */
function watching(socket: string) {
	const connection: Socket = createConnection(socket);
	connection.write(`${JSON.stringify({ v: 1, id: "w", op: "watch" })}\n`);
	const frames = jsonLines();
	async function* heard() {
		for await (const chunk of connection)
			for (const value of frames.push(
				typeof chunk === "string" ? Buffer.from(chunk) : chunk,
			))
				yield value;
	}
	return heard();
}

/** Each line after the answer, up to and with the ending. */
async function toEnding(lines: AsyncGenerator<unknown>) {
	const rest: unknown[] = [];
	for await (const line of lines) {
		rest.push(line);
		if (parseWatchLine(line).type === "ending") break;
	}
	return rest;
}

it(
	"an open child ends closed once its conversation closes, telling systemd nothing",
	async () => {
		const child = await startChild("fresh", {});
		const lines = watching(child.socket);
		const opened = parseOpenResult(
			resultOf(
				await controlRequest(child.socket, {
					v: 1,
					id: "o",
					op: "open",
					cwd: sealed.home,
					attended: false,
				}),
			),
		);
		const answer = await lines.next();
		expect(answer.value).toMatchObject({ id: "w", ok: true });
		const watched = parseWatchResult(resultIn(answer.value));
		expect(watched.conversation.sessionId).toBe(opened.sessionId);
		expect(watched.entry).toMatchObject({
			sessionId: opened.sessionId,
			file: opened.file,
			cwd: sealed.home,
			attended: false,
		});
		await controlRequest(child.socket, {
			v: 1,
			id: "c",
			op: "close",
			sessionId: opened.sessionId,
			expectedHost: watched.host,
		});
		expect((await toEnding(lines)).at(-1)).toEqual({
			type: "ending",
			why: "closed",
		});
		expect(await child.exited, child.errors()).toBe(0);
		expect(JSON.parse(child.said())).toEqual({ why: "closed", notify: null });
	},
	CASE_MS,
);

it(
	"a resumed child ends parked at a stop signal, and exits 0",
	async () => {
		const file = join(sealed.home, `${SESSION}.jsonl`);
		await writeFile(file, "");
		const child = await startChild("r", {
			session: {
				sessionId: SESSION,
				file,
				cwd: sealed.home,
				attended: false,
				since: "2026-11-19T21:00:00.000Z",
			},
		});
		const lines = watching(child.socket);
		const answer = await lines.next();
		expect(answer.value).toMatchObject({
			ok: true,
			result: { conversation: { sessionId: SESSION } },
		});
		child.process.kill("SIGTERM");
		expect((await toEnding(lines)).at(-1)).toEqual({
			type: "ending",
			why: "parked",
		});
		expect(await child.exited, child.errors()).toBe(0);
	},
	CASE_MS,
);

it(
	"a child refuses a second conversation",
	async () => {
		const child = await startChild("fresh", {});
		const open = (id: string) =>
			controlRequest(child.socket, {
				v: 1,
				id,
				op: "open",
				cwd: sealed.home,
				attended: false,
			});
		expect((await open("first")).ok, "the first open").toBe(true);
		const second = await open("second");
		expect(second).toMatchObject({
			ok: false,
			error: { code: "rollout_refused" },
		});
		child.process.kill("SIGTERM");
		expect(await child.exited, child.errors()).toBe(0);
	},
	CASE_MS,
);
