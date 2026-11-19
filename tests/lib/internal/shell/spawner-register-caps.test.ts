/**
 * How much a host says of the node's refusals at most: each file starts
 * the host's once-only set empty, so these fill it without spoiling the
 * other tests. A stand-in node answers each telling with the reason it
 * is given, and a folder stands in for /proc.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { registerSpawner } from "../../../../lib/internal/shell/spawner-register.ts";

const SPAWNER = 4242;
const SPAWNED = { pid: SPAWNER, started: 987_654 };

/** How many reasons a host says, as the module keeps it. */
const REASONS_SAID = 32;

/** How much of one reason is said, as the module keeps it. */
const REASON_CHARS = 300;

const LINE =
	"pi-spawner's session isn't named to the mycelium node, so its commands are told no conversation: ";

const at = mkdtempSync(join(tmpdir(), "spawner-register-caps-"));
const servers: Server[] = [];

afterAll(() => {
	for (const server of servers) server.close();
	rmSync(at, { recursive: true, force: true });
});

/** A /proc holding the spawner, as /proc would show it. */
function proc(): string {
	const folder = join(at, "proc");
	mkdirSync(join(folder, `${SPAWNER}`), { recursive: true });
	writeFileSync(join(folder, `${SPAWNER}`, "comm"), "pi-spawner\n");
	return folder;
}

/** A node on a socket of its own, refusing every telling for `why`. */
async function refusing(why: string): Promise<string> {
	const socket = join(at, `node-${servers.length}.sock`);
	const server = createServer((connection) => {
		connection.on("data", () =>
			connection.write(`${JSON.stringify({ Err: why })}\n`),
		);
	});
	servers.push(server);
	await new Promise<void>((ready) => server.listen(socket, () => ready()));
	return socket;
}

/** The letters `count` stands for, so no two reasons differ only by a number. */
function lettered(count: number): string {
	return count
		.toString(26)
		.split("")
		.map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 26)))
		.join("");
}

describe("how much a host says of the node's refusals", () => {
	// One test, since the once-only set is the process's, which only
	// vitest's file isolation starts empty and nothing here clears: each
	// reason counts towards the cap, so the cut's cases are the first said.
	it("cuts a reason past its characters, by character, then says no more past its reasons, and says so once", async () => {
		const said: string[] = [];
		const folder = proc();
		const tell = async (why: string) =>
			await registerSpawner(SPAWNED, "s-one", {
				socket: await refusing(why),
				proc: folder,
				say: (line: string) => said.push(line),
			});

		await tell("x".repeat(REASON_CHARS + 1));
		await tell("y".repeat(REASON_CHARS));
		// Each takes two UTF-16 units, and none is split.
		await tell("\u{1F344}".repeat(REASON_CHARS + 1));

		expect(said, "what the host said of each").toEqual([
			`${LINE}${"x".repeat(REASON_CHARS)}...\n`,
			`${LINE}${"y".repeat(REASON_CHARS)}\n`,
			`${LINE}${"\u{1F344}".repeat(REASON_CHARS)}...\n`,
		]);

		const first = said.length;
		for (let reason = first + 1; reason <= REASONS_SAID + 2; reason++) {
			await tell(`the node says ${lettered(reason)}`);
		}

		expect(said.length, "how many lines the host said").toBe(REASONS_SAID + 1);
		expect(said.at(-1), "its last").toBe(
			`pi-spawner's host has said ${REASONS_SAID} reasons the mycelium node refused, and says no more until it restarts\n`,
		);
	});
});
