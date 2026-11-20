/**
 * The host's connection to the node, as a command it starts sees it: a
 * child process reads its own descriptors, so this runs in the process
 * lane (vitest.config.ts's PROCESS_TESTS).
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
import { registerSpawner } from "../../../../lib/internal/shell/spawner-register.ts";

const SPAWNER = 4242;
/** Any start: the telling says the one it is given. */
const SPAWNER_STARTED = 1;

/**
 * Longer than any test runs, so the connection is open until the test
 * ends it, however slowly the command starts.
 */
const HELD_OPEN_MS = 600_000;

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

/** A /proc holding `pid` as a running pi-spawner. */
function procWithSpawner(pid: number): string {
	const proc = folder();
	mkdirSync(join(proc, `${pid}`));
	writeFileSync(join(proc, `${pid}`, "comm"), "pi-spawner\n");
	const fields = ["S", ...Array.from({ length: 18 }, (_, at) => `${at}`)];
	writeFileSync(
		join(proc, `${pid}`, "stat"),
		`${pid} (pi-spawner) ${fields.join(" ")} 987654 0 0\n`,
	);
	return proc;
}

/** A stand-in node that hears and never answers, holding each connection. */
function silentNode() {
	const socket = join(folder(), "node.sock");
	const connections: Socket[] = [];
	const server = createServer((connection) => {
		connections.push(connection);
	});
	serving.push(server);
	const opened = new Promise<void>((ready) =>
		server.once("connection", () => ready()),
	);
	const listening = new Promise<void>((ready) =>
		server.listen(socket, () => ready()),
	);
	return { socket, connections, opened, listening };
}

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
			const stand = silentNode();
			await stand.listening;
			const before = socketsHeld();

			const telling = registerSpawner(
				{ pid: SPAWNER, started: SPAWNER_STARTED },
				"s-one",
				{
					socket: stand.socket,
					proc: procWithSpawner(SPAWNER),
					patience: HELD_OPEN_MS,
				},
			);
			await stand.opened;
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
