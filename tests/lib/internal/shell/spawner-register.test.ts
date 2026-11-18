/**
 * A host telling the node which session a spawner serves: a stand-in
 * node on a socket of its own hears what's said, and a folder stands in
 * for /proc, so nothing real is started or named.
 */
import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	registerSpawner,
	startOf,
} from "../../../../lib/internal/shell/spawner-register.ts";

const SPAWNER = 4242;
const STARTED = 987_654;

/** A short wait for things that must not happen. */
const BRIEFLY_MS = 50;

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
	// Twenty fields after the name, the last its start; the name holds a
	// space and a bracket, as a process's may.
	const fields = ["S", ...Array.from({ length: 18 }, (_, at) => `${at}`)];
	writeFileSync(
		join(proc, `${pid}`, "stat"),
		`${pid} (${name} x) ${fields.join(" ")} ${started} 0 0\n`,
	);
	return proc;
}

/** A stand-in node: what each connection says, answered with `answer`. */
function node(answer: string | undefined = '{"Ok":"Spawned"}') {
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
			if (answer !== undefined) connection.write(`${answer}\n`);
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
		await new Promise((settle) => setTimeout(settle, BRIEFLY_MS));
		expect(stand.heard, "said before the spawner ran").toEqual([]);
		writeFileSync(join(proc, `${SPAWNER}`, "comm"), "pi-spawner\n");
		await telling;

		expect(stand.heard, "said once it ran").toHaveLength(1);
	});

	it("says nothing of one that never goes by pi-spawner's name", async () => {
		const stand = node();
		await stand.listening;

		await registerSpawner(SPAWNER, "s-one", {
			socket: stand.socket,
			proc: procWith(SPAWNER, "sh"),
			patience: BRIEFLY_MS,
		});

		expect(stand.heard, "what the node heard").toEqual([]);
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
		const stand = node(undefined);
		await stand.listening;

		await registerSpawner(SPAWNER, "s-one", {
			socket: stand.socket,
			proc: procWith(SPAWNER, "pi-spawner"),
			patience: BRIEFLY_MS,
		});

		expect(stand.heard, "it was said, though unanswered").toHaveLength(1);
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

/** The sockets this process holds, by the inode /proc names each. */
function socketsHeld(): Set<string> {
	const held = new Set<string>();
	for (const fd of readdirSync("/proc/self/fd")) {
		try {
			const target = readlinkSync(`/proc/self/fd/${fd}`);
			if (target.startsWith("socket:")) held.add(target);
		} catch {
			// The listing's own descriptor, closed once read.
		}
	}
	return held;
}

/** The sockets a command started now holds, as it reads its own /proc. */
function socketsAChildHolds(): Promise<string[]> {
	const script = `
const fs = require("node:fs");
const held = fs.readdirSync("/proc/self/fd").flatMap((fd) => {
	try { return [fs.readlinkSync("/proc/self/fd/" + fd)]; } catch { return []; }
});
process.stdout.write(JSON.stringify(held.filter((t) => t.startsWith("socket:"))));`;
	return new Promise((settle, fail) =>
		execFile(process.execPath, ["-e", script], (error, out) =>
			error ? fail(error) : settle(JSON.parse(out)),
		),
	);
}

describe.skipIf(process.platform !== "linux")(
	"the host's connection to the node",
	() => {
		it("is held by no command the host starts while it is open", async () => {
			const stand = node(undefined);
			await stand.listening;
			const before = socketsHeld();
			const opened = new Promise<void>((ready) =>
				stand.listening.then(() =>
					serving[serving.length - 1]?.once("connection", () => ready()),
				),
			);

			const telling = registerSpawner(SPAWNER, "s-one", {
				socket: stand.socket,
				proc: procWith(SPAWNER, "pi-spawner"),
			});
			await opened;
			const opening = [...socketsHeld()].filter((one) => !before.has(one));
			const childHolds = await socketsAChildHolds();
			for (const connection of stand.connections) connection.destroy();
			await telling;

			expect(opening.length, "sockets the telling opened").toBeGreaterThan(0);
			expect(
				childHolds.filter((one) => opening.includes(one)),
				"the telling's sockets a command holds",
			).toEqual([]);
		});
	},
);
