/**
 * Realm flows: which realms the node lets this one send to, and a send
 * across through it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	crossAt,
	flowsAt,
	meshGroupOf,
	nodeGroupOf,
} from "../../../lib/mesh/flow.ts";

let root: string;
let servers: Server[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-flow-"));
	servers = [];
});

afterEach(async () => {
	await Promise.all(
		servers.map((server) => new Promise((done) => server.close(done))),
	);
	rmSync(root, { recursive: true, force: true });
});

/** A node at a socket in the test's folder, answering each line it reads. */
async function serving(answer: (line: string) => string | undefined) {
	const socket = join(root, "personal.sock");
	const server = createServer((client) => {
		client.setEncoding("utf8");
		client.on("data", (line: string) => {
			const said = answer(line.trim());
			if (said !== undefined) client.write(`${said}\n`);
		});
	});
	servers.push(server);
	await new Promise<void>((listening) => server.listen(socket, listening));
	return socket;
}

const crossing = {
	realm: "work",
	from: "C33R38",
	to: ["@4UHC5Q"],
	intent: "fyi",
	text: "the flow holds",
};

describe("asking the node which realms this one may send to", () => {
	it("names the realms its flows go to", async () => {
		const socket = await serving((line) =>
			line === '"Flows"'
				? JSON.stringify({ Ok: { Flows: { to: ["work", "lab"] } } })
				: undefined,
		);
		expect(await flowsAt(socket)).toEqual(["work", "lab"]);
	});

	it("takes a node that doesn't know flows, or no node, for none", async () => {
		const socket = await serving(() =>
			JSON.stringify({ Err: "not a request: unknown variant `Flows`" }),
		);
		expect(await flowsAt(socket)).toEqual([]);
		expect(await flowsAt(join(root, "nobody.sock"), 100)).toEqual([]);
		expect(await flowsAt(undefined)).toEqual([]);
	});
});

describe("sending across through the node", () => {
	it("says why when the node answers an error rather than a refusal", async () => {
		const socket = await serving(() =>
			JSON.stringify({ Err: "not a request: unknown field `realm`" }),
		);
		expect(await crossAt(socket, crossing)).toEqual({
			ok: false,
			code: "err",
			why: "not a request: unknown field `realm`",
		});
	});

	it("says so when no node answers, rather than taking it as sent", async () => {
		expect(await crossAt(join(root, "nobody.sock"), crossing, 100)).toEqual({
			ok: false,
			code: "unanswered",
			why: "no mycelium node answered this realm's socket",
		});
	});
});

describe("naming groups as the node does", () => {
	it("writes a peer's home and a named group the node's way, and back", () => {
		expect(nodeGroupOf("@4UHC5Q")).toBe("peer.4uhc5q");
		expect(nodeGroupOf("#quest/wcjqsg")).toBe("quest.wcjqsg");
		expect(meshGroupOf("peer.4uhc5q")).toBe("@4UHC5Q");
		expect(meshGroupOf("quest.wcjqsg")).toBe("#quest/wcjqsg");
	});
});
