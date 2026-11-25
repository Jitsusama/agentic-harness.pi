/**
 * A folder transport whose arrivals the node says: heard over the node's
 * watch and read without a file, and heard by the folder itself while no
 * node answers, until it is asked again.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Draft } from "../../../lib/mesh/message.ts";
import { nodeTransport } from "../../../lib/mesh/node-transport.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";

let dir: string;
let server: Server | undefined;
let clients: Socket[];
// Whether the fake node answers a watch, and what it says once watching.
let answers: boolean;
const stops: (() => void)[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ntr-"));
	clients = [];
	answers = true;
});

afterEach(async () => {
	for (const stop of stops.splice(0)) stop();
	for (const client of clients) client.destroy();
	await new Promise<void>((done) => {
		if (server === undefined) done();
		else server.close(() => done());
	});
	server = undefined;
	rmSync(dir, { recursive: true, force: true });
});

const socketPath = (): string => join(dir, "node.sock");

/** A node that takes each watch, as mycelium's does, once it answers. */
async function node(): Promise<void> {
	server = createServer((client) => {
		clients.push(client);
		// A transport that stopped closes its end, so the node's next word
		// to it fails with EPIPE, as a real node's would; the test reads what
		// the transport heard, not what the node could still write.
		client.on("error", () => undefined);
		client.once("data", () => {
			if (answers) client.write(`${JSON.stringify({ Ok: "Watching" })}\n`);
		});
	});
	const listening = server;
	await new Promise<void>((done) => listening.listen(socketPath(), done));
}

/** The node saying a message to every watch it holds. */
function say(id: string, text: string): void {
	const message = {
		id,
		at: "2026-11-21T18:00:00.000Z",
		from: "WCJQSG",
		groups: ["peer.osphtp"],
		intent: "fyi",
		text,
		pid: 7,
	};
	for (const client of clients)
		client.write(`${JSON.stringify({ Message: { message } })}\n`);
}

const draft = (text: string): Draft => ({
	from: "WCJQSG",
	to: ["@OSPHTP"],
	intent: "fyi",
	text,
	pid: 7,
});

/** A transport of `dir`'s messages, its watch stopped after the test. */
function watching(
	socket: () => string | undefined,
	times = {},
): { arrived: string[]; transport: ReturnType<typeof nodeTransport> } {
	const transport = nodeTransport(folderTransport(dir), socket, times);
	const arrived: string[] = [];
	stops.push(transport.watch((id) => arrived.push(id)));
	return { arrived, transport };
}

describe("a transport the node says arrivals to", () => {
	it("hears each message the node says, and reads it without its file", async () => {
		await node();
		const { arrived, transport } = watching(socketPath);
		await vi.waitFor(() => expect(clients.length, "watched").toBe(1));
		// Its yes reached the transport once a message said after it does.
		await vi.waitFor(() => {
			say("1793046604647-WCJQSG-7-00000001", "over the socket");
			expect(arrived, "heard").toContain("1793046604647-WCJQSG-7-00000001");
		});
		expect(
			existsSync(join(dir, "1793046604647-WCJQSG-7-00000001.json")),
			"no file for it",
		).toBe(false);
		expect(
			transport.read("1793046604647-WCJQSG-7-00000001")?.text,
			"read from what the node said",
		).toBe("over the socket");
	});

	it("stops hearing by the folder once the node takes the watch", async () => {
		await node();
		const { arrived } = watching(socketPath);
		await vi.waitFor(() => {
			say("1793046604647-WCJQSG-7-00000001", "the node has it");
			expect(arrived.length, "the node's word heard").toBeGreaterThan(0);
		});
		const sent = folderTransport(dir).send(draft("written behind it"));
		// Long enough for the folder's watch to say it, were it kept.
		await new Promise((done) => setTimeout(done, 300));
		expect(arrived, "not heard by the folder").not.toContain(sent.id);
	});

	it("hears by the folder while no node is named", async () => {
		const { arrived } = watching(() => undefined);
		const sent = folderTransport(dir).send(draft("on disk"));
		await vi.waitFor(() =>
			expect(arrived, "heard by the folder").toContain(sent.id),
		);
	});

	it("hears by the folder once the node goes, and asks it again later", async () => {
		await node();
		const { arrived } = watching(socketPath, { againMs: 200 });
		await vi.waitFor(() => {
			say("1793046604647-WCJQSG-7-00000001", "before it went");
			expect(arrived.length, "the node's word heard").toBeGreaterThan(0);
		});
		for (const client of clients) client.destroy();
		// Sent until the folder's watch, started again, hears one: a write
		// landing before it starts is the minute's look's to hear, not this.
		const sent: string[] = [];
		await vi.waitFor(() => {
			sent.push(folderTransport(dir).send(draft("after it went")).id);
			expect(
				arrived.some((id) => sent.includes(id)),
				"heard by the folder",
			).toBe(true);
		});
		await vi.waitFor(() => expect(clients.length, "asked again").toBe(2), {
			timeout: 3000,
		});
	});

	it("counts a node that never takes the watch as gone", async () => {
		answers = false;
		await node();
		const { arrived } = watching(socketPath, { readyMs: 100, againMs: 100 });
		await vi.waitFor(() => expect(clients.length, "watched").toBe(1));
		await vi.waitFor(
			() => expect(clients.length, "asked again").toBeGreaterThan(1),
			{ timeout: 3000 },
		);
		const sent = folderTransport(dir).send(draft("on disk"));
		await vi.waitFor(() =>
			expect(arrived, "heard by the folder").toContain(sent.id),
		);
	});

	it("hears nothing once its watch is stopped", async () => {
		await node();
		const transport = nodeTransport(folderTransport(dir), socketPath);
		const arrived: string[] = [];
		const stop = transport.watch((id) => arrived.push(id));
		await vi.waitFor(() => expect(clients.length, "watched").toBe(1));
		stop();
		say("1793046604647-WCJQSG-7-00000001", "after the stop");
		folderTransport(dir).send(draft("after the stop"));
		// Long enough for the node's word or the folder's watch to be heard,
		// were either still kept.
		await new Promise((done) => setTimeout(done, 300));
		expect(arrived, "nothing heard").toEqual([]);
	});
});
