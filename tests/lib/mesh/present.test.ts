import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isKeptPresent,
	keepPresent,
	stopPresent,
	whenPresent,
} from "../../../lib/mesh/present.ts";
import { until } from "../../support/until.ts";

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

/**
 * How long a socket event gets to run. Nothing tells the test when one
 * has, so it is polled for; a second is ample within one process, and
 * failing then names the wait rather than the test's own timeout.
 */
const HEARD_WITHIN_MS = 1_000;

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

		await until(
			"the node counts this process present",
			isKeptPresent,
			HEARD_WITHIN_MS,
		);
		expect(heard.said, "one word, once").toEqual(['"Present"']);
		expect(heard.open, "the connection stays open").toHaveLength(1);
	});

	it("keeps the one connection when loaded again in the same process", async () => {
		const heard = await node('{"Ok":"Present"}');
		keepPresent(() => path);
		await until("the first load is present", isKeptPresent, HEARD_WITHIN_MS);

		keepPresent(() => path);

		expect(heard.connections, "a reload opens no second connection").toBe(1);
		expect(isKeptPresent(), "and stays present").toBe(true);
	});

	it("connects again after the node drops it", async () => {
		const heard = await node('{"Ok":"Present"}');
		keepPresent(() => path, 10);
		await until(
			"the first connection is present",
			isKeptPresent,
			HEARD_WITHIN_MS,
		);

		heard.open[0]?.destroy();

		await until(
			"a second connection",
			() => heard.connections === 2,
			HEARD_WITHIN_MS,
		);
		await until("present again", isKeptPresent, HEARD_WITHIN_MS);
	});

	it("waits longer before asking a node that refused", async () => {
		const heard = await node(
			'{"Err":"not a request: unknown variant `Present`"}',
		);

		keepPresent(() => path, 10, 60_000);

		await until(
			"the node was asked",
			() => heard.said.length === 1,
			HEARD_WITHIN_MS,
		);
		await until(
			"the refused connection closed",
			() => heard.open.length === 0,
			HEARD_WITHIN_MS,
		);
		await new Promise((next) => setTimeout(next, 50));
		expect(isKeptPresent(), "a refusal counts nothing").toBe(false);
		expect(heard.connections, "not asked again at the short retry").toBe(1);
	});

	it("tries again while no node is named", async () => {
		let named: string | undefined;
		const heard = await node('{"Ok":"Present"}');

		keepPresent(() => named, 10);
		named = path;

		await until("present once a node is named", isKeptPresent, HEARD_WITHIN_MS);
		expect(heard.connections).toBe(1);
	});
});

describe("hearing when the node counts this process present", () => {
	afterEach(() => {
		for (const stop of unhearing.splice(0)) stop();
	});
	const unhearing: (() => void)[] = [];

	it("says so once present, and again after the node drops it, as a restart does", async () => {
		const heard = await node('{"Ok":"Present"}');
		let times = 0;
		unhearing.push(
			whenPresent(() => {
				times += 1;
			}),
		);
		keepPresent(() => path, 10);
		await until("heard the first time", () => times === 1, HEARD_WITHIN_MS);

		heard.open[0]?.destroy();

		await until(
			"heard again once present anew",
			() => times === 2,
			HEARD_WITHIN_MS,
		);
	});

	it("says nothing to a listener stopped, as a reload's old load is", async () => {
		await node('{"Ok":"Present"}');
		let old = 0;
		let fresh = 0;
		whenPresent(() => {
			old += 1;
		})();
		unhearing.push(
			whenPresent(() => {
				fresh += 1;
			}),
		);

		keepPresent(() => path, 10);

		await until("the new load heard", () => fresh === 1, HEARD_WITHIN_MS);
		expect(old).toBe(0);
	});
});
