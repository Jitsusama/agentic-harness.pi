/**
 * A host telling the node which session a spawner serves: a stand-in
 * node on a socket of its own hears what's said, and a folder stands in
 * for /proc, so nothing real is started or named.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	NAME_PATIENCE_MS,
	REGISTER_PATIENCE_MS,
	registerSpawner,
	startOf,
} from "../../../../lib/internal/shell/spawner-register.ts";

const SPAWNER = 4242;
const STARTED = 987_654;

/** A short wait for things that must not happen. */
const BRIEFLY_MS = 50;

/** How early a timer may fire, as the wall clock reads it. */
const TIMER_SLACK_MS = 10;

/** A patience shorter than the default, to show the one given is kept. */
const SHORT_PATIENCE_MS = 300;

const made: string[] = [];
const serving: Server[] = [];

afterEach(() => {
	for (const server of serving.splice(0)) server.close();
	for (const folder of made.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

/** A folder of its own, removed after the test. */
function folder(): string {
	const at = mkdtempSync(join(tmpdir(), "spawner-register-"));
	made.push(at);
	return at;
}

/** A /proc holding `pid`, going by `name`, started at `started`. */
function procWith(pid: number, name: string, started = STARTED): string {
	const proc = folder();
	mkdirSync(join(proc, `${pid}`));
	writeFileSync(join(proc, `${pid}`, "comm"), `${name}\n`);
	statOf(proc, pid, name, started);
	return proc;
}

/**
 * Writes `pid`'s stat in `proc`: its state, eighteen fields more, its
 * start as the twenty-second and two after. The name holds a space and a
 * closing bracket, as a process's may.
 */
function statOf(proc: string, pid: number, name: string, started: number) {
	const fields = ["S", ...Array.from({ length: 18 }, (_, at) => `${at}`)];
	writeFileSync(
		join(proc, `${pid}`, "stat"),
		`${pid} (${name} x) y) ${fields.join(" ")} ${started} 0 0\n`,
	);
}

/** A stand-in node: what each connection says, answered with `answer`. */
function node(answer: string | false = '{"Ok":"Spawned"}') {
	const socket = join(folder(), "node.sock");
	const heard: unknown[] = [];
	const connections: Socket[] = [];
	const server = createServer((connection) => {
		connections.push(connection);
		connection.setEncoding("utf8");
		let said = "";
		connection.on("data", (chunk: string) => {
			said += chunk;
			const end = said.indexOf("\n");
			if (end < 0) return;
			heard.push(JSON.parse(said.slice(0, end)));
			if (answer !== false) connection.write(`${answer}\n`);
		});
	});
	serving.push(server);
	const listening = new Promise<void>((ready) =>
		server.listen(socket, () => ready()),
	);
	return { socket, heard, connections, listening };
}

describe("a host telling the node a spawner's session", () => {
	it("says the spawner, its start as /proc reads it, and the session", async () => {
		const stand = node();
		await stand.listening;

		await registerSpawner(SPAWNER, "s-one", {
			socket: stand.socket,
			proc: procWith(SPAWNER, "pi-spawner"),
		});

		expect(stand.heard, "what the node heard").toEqual([
			{ Spawned: { pid: SPAWNER, started: STARTED, session: "s-one" } },
		]);
	});

	it("waits for the spawner's own name, as one in a scope goes by another first", async () => {
		const stand = node();
		await stand.listening;
		const proc = procWith(SPAWNER, "systemd-run");

		const telling = registerSpawner(SPAWNER, "s-one", {
			socket: stand.socket,
			proc,
		});
		// Nothing is said meanwhile, and nothing is there to wait on for it.
		await new Promise((settle) => setTimeout(settle, BRIEFLY_MS));
		expect(stand.heard, "said before the spawner ran").toEqual([]);
		writeFileSync(join(proc, `${SPAWNER}`, "comm"), "pi-spawner\n");
		await telling;

		expect(stand.heard, "said once it ran").toHaveLength(1);
	});

	it("says the start read before the wait, so a spawner gone meanwhile is never named", async () => {
		const stand = node();
		await stand.listening;
		const proc = procWith(SPAWNER, "systemd-run");

		const telling = registerSpawner(SPAWNER, "s-one", {
			socket: stand.socket,
			proc,
		});
		// Nothing is said meanwhile, and nothing is there to wait on for it.
		await new Promise((settle) => setTimeout(settle, BRIEFLY_MS));
		statOf(proc, SPAWNER, "pi-spawner", STARTED + 1);
		writeFileSync(join(proc, `${SPAWNER}`, "comm"), "pi-spawner\n");
		await telling;

		expect(stand.heard, "what the node heard").toEqual([
			{ Spawned: { pid: SPAWNER, started: STARTED, session: "s-one" } },
		]);
	});

	it("says nothing of one that never goes by pi-spawner's name, once its patience is spent", async () => {
		const stand = node();
		await stand.listening;
		const began = Date.now();

		await registerSpawner(SPAWNER, "s-one", {
			socket: stand.socket,
			proc: procWith(SPAWNER, "sh"),
			namePatience: SHORT_PATIENCE_MS,
		});

		expect(stand.heard, "what the node heard").toEqual([]);
		expect(Date.now() - began, "how long it waited").toBeGreaterThanOrEqual(
			SHORT_PATIENCE_MS - TIMER_SLACK_MS,
		);
		expect(Date.now() - began, "how long it waited").toBeLessThan(
			NAME_PATIENCE_MS,
		);
	});

	it("says nothing of one /proc doesn't hold, as on a Mac or once it's gone", async () => {
		const stand = node();
		await stand.listening;

		await registerSpawner(SPAWNER, "s-one", {
			socket: stand.socket,
			proc: folder(),
		});

		expect(stand.connections, "connections the node took").toEqual([]);
	});

	it("says nothing where no node is named", async () => {
		await expect(
			registerSpawner(SPAWNER, "s-one", {
				socket: undefined,
				proc: procWith(SPAWNER, "pi-spawner"),
			}),
		).resolves.toBeUndefined();
	});

	it("gives up once its patience runs out, when the node never answers", async () => {
		const stand = node(false);
		await stand.listening;
		const began = Date.now();

		await registerSpawner(SPAWNER, "s-one", {
			socket: stand.socket,
			proc: procWith(SPAWNER, "pi-spawner"),
			patience: SHORT_PATIENCE_MS,
		});

		expect(Date.now() - began, "how long it waited").toBeGreaterThanOrEqual(
			SHORT_PATIENCE_MS - TIMER_SLACK_MS,
		);
		expect(Date.now() - began, "how long it waited").toBeLessThan(
			REGISTER_PATIENCE_MS,
		);
	});

	it("gives up at once where nothing serves the socket", async () => {
		await expect(
			registerSpawner(SPAWNER, "s-one", {
				socket: join(folder(), "none.sock"),
				proc: procWith(SPAWNER, "pi-spawner"),
			}),
		).resolves.toBeUndefined();
	});
});

describe("a spawner's start, as /proc says it", () => {
	it("is the stat's twenty-second field, past a name holding spaces", async () => {
		expect(await startOf(SPAWNER, procWith(SPAWNER, "pi spawner"))).toBe(
			STARTED,
		);
	});

	it("is nothing for a process that isn't there", async () => {
		expect(await startOf(SPAWNER, folder())).toBeUndefined();
	});
});
