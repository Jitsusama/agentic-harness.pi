import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isKeptPresent,
	keepPresent,
	stopPresent,
} from "../../../lib/mesh/present.ts";

let dir: string;
let path: string;
let server: Server | undefined;

/** A stand-in node: what each connection said, and the connections open. */
interface Node {
	readonly said: string[];
	readonly open: Socket[];
	connections: number;
}

/** Serves `path`, answering each line with `answer`. */
async function node(answer: string): Promise<Node> {
	const heard: Node = { said: [], open: [], connections: 0 };
	server = createServer((socket) => {
		heard.connections += 1;
		heard.open.push(socket);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			for (const line of chunk.split("\n").filter(Boolean)) {
				heard.said.push(line);
				socket.write(`${answer}\n`);
			}
		});
		socket.on("close", () => heard.open.splice(heard.open.indexOf(socket), 1));
	});
	const listening = server;
	await new Promise<void>((done) => listening.listen(path, done));
	return heard;
}

/** Waits until `holds` does, failing after a second. */
async function until(holds: () => boolean, what: string): Promise<void> {
	const by = Date.now() + 1000;
	// Nothing tells the test when a socket event has run, so it looks
	// again each few milliseconds.
	while (!holds()) {
		if (Date.now() > by) throw new Error(`never: ${what}`);
		await new Promise((next) => setTimeout(next, 5));
	}
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "present-"));
	path = join(dir, "work.sock");
});
afterEach(async () => {
	stopPresent();
	const closing = server;
	server = undefined;
	if (closing) await new Promise((done) => closing.close(done));
	rmSync(dir, { recursive: true, force: true });
});

describe("being present on the node", () => {
	it("says Present once and holds the connection open", async () => {
		const heard = await node('{"Ok":"Present"}');

		keepPresent(() => path);

		await until(isKeptPresent, "the node counts this process present");
		expect(heard.said, "one word, once").toEqual(['"Present"']);
		expect(heard.open, "the connection stays open").toHaveLength(1);
	});

	it("keeps the one connection when loaded again in the same process", async () => {
		const heard = await node('{"Ok":"Present"}');
		keepPresent(() => path);
		await until(isKeptPresent, "the first load is present");

		keepPresent(() => path);

		expect(heard.connections, "a reload opens no second connection").toBe(1);
		expect(isKeptPresent(), "and stays present").toBe(true);
	});

	it("connects again after the node drops it", async () => {
		const heard = await node('{"Ok":"Present"}');
		keepPresent(() => path, 10);
		await until(isKeptPresent, "the first connection is present");

		heard.open[0]?.destroy();

		await until(() => heard.connections === 2, "a second connection");
		await until(isKeptPresent, "present again");
	});

	it("waits longer before asking a node that refused", async () => {
		const heard = await node(
			'{"Err":"not a request: unknown variant `Present`"}',
		);

		keepPresent(() => path, 10, 60_000);

		await until(() => heard.said.length === 1, "the node was asked");
		await until(() => heard.open.length === 0, "the refused connection closed");
		await new Promise((next) => setTimeout(next, 50));
		expect(isKeptPresent(), "a refusal counts nothing").toBe(false);
		expect(heard.connections, "not asked again at the short retry").toBe(1);
	});

	it("tries again while no node is named", async () => {
		let named: string | undefined;
		const heard = await node('{"Ok":"Present"}');

		keepPresent(() => named, 10);
		named = path;

		await until(isKeptPresent, "present once a node is named");
		expect(heard.connections).toBe(1);
	});
});
