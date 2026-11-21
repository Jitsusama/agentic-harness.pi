/**
 * The machine's sessions as its node's watch says them: the whole state
 * then each change, a presence file a session, and a node that isn't
 * there, refuses or says what this reader can't read ends the feed as
 * lost.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedEvents } from "../../../lib/internal/files/folder-mirror.ts";
import {
	type SessionFiles,
	sessionsHeard,
	watchSessions,
} from "../../../lib/mesh/node-watch.ts";

/** A presence's words, so a test reads what each file was told. */
const FILES: SessionFiles<string> = {
	nameOf: (id) => `${id}.json`,
	parse: (presence) =>
		typeof presence === "object" && presence !== null && "says" in presence
			? String(presence.says)
			: undefined,
};

/** What a feed was told, in order, as short lines. */
function told(): { events: FeedEvents<string>; said: string[] } {
	const said: string[] = [];
	return {
		said,
		events: {
			put: (name, value) => said.push(`put ${name} ${value ?? "none"}`),
			gone: (name) => said.push(`gone ${name}`),
			ready: () => said.push("ready"),
			ended: (how) => said.push(`ended ${how}`),
		},
	};
}

/** A session as a watch carries it, its presence saying `says`. */
function session(id: string, says: string) {
	return { id, address: id.toUpperCase(), presence: { says } };
}

const line = (said: unknown) => JSON.stringify(said);

describe("what a node's watch says, heard", () => {
	it("puts every session, says ready once, then each change and each forgotten", () => {
		const { events, said } = told();
		const end = vi.fn();
		const hear = sessionsHeard(FILES, events, end);
		hear(line({ Ok: "Watching" }));
		hear(
			line({
				SessionsChanged: {
					sessions: [session("a", "one"), session("b", "two")],
				},
			}),
		);
		hear(line({ MessagesChanged: { messages: [] } }));
		hear(line({ SessionChanged: { session: session("a", "again") } }));
		hear(line({ SessionChanged: { session: { id: "c", address: "C" } } }));
		hear(line({ SessionForgotten: { id: "b" } }));
		expect(said).toEqual([
			"put a.json one",
			"put b.json two",
			"ready",
			"put a.json again",
			"put c.json none",
			"gone b.json",
		]);
		expect(end, "nothing it couldn't read").not.toHaveBeenCalled();
	});

	it("lets go of what a whole state said again no longer holds, and says ready only once", () => {
		const { events, said } = told();
		const hear = sessionsHeard(FILES, events, vi.fn());
		hear(line({ Ok: "Watching" }));
		hear(
			line({
				SessionsChanged: {
					sessions: [session("a", "one"), session("b", "two")],
				},
			}),
		);
		hear(line({ SessionsChanged: { sessions: [session("b", "two")] } }));
		expect(said).toEqual([
			"put a.json one",
			"put b.json two",
			"ready",
			"put b.json two",
			"gone a.json",
		]);
	});

	it.each([
		["a refusal", line({ Err: "no such ask" }), false],
		["no JSON", "{not json", false],
		[
			"a state that isn't a list",
			line({ SessionsChanged: { sessions: 3 } }),
			true,
		],
		["a session with no id", line({ SessionChanged: { session: {} } }), true],
		["a forgetting with no id", line({ SessionForgotten: {} }), true],
		["an event it doesn't know", line({ Weather: {} }), true],
	])("ends on %s", (_name, said, afterWatching) => {
		const { events } = told();
		const end = vi.fn();
		const hear = sessionsHeard(FILES, events, end);
		if (afterWatching) hear(line({ Ok: "Watching" }));
		hear(said);
		expect(end, "the feed ends").toHaveBeenCalledTimes(1);
	});
});

describe("a watch on a node's socket", () => {
	let dir: string;
	let server: Server | undefined;
	let clients: Socket[];
	let asks: string[];
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "nw-"));
		clients = [];
		asks = [];
	});
	afterEach(async () => {
		for (const client of clients) client.destroy();
		await new Promise<void>((done) => {
			if (server === undefined) done();
			else server.close(() => done());
		});
		server = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	/** A node that answers a watch with `lines`, keeping each client. */
	async function node(lines: unknown[]): Promise<string> {
		const path = join(dir, "n.sock");
		server = createServer((client) => {
			clients.push(client);
			client.setEncoding("utf8");
			client.once("data", (ask: string) => {
				asks.push(ask);
				client.write(lines.map((one) => `${line(one)}\n`).join(""));
			});
		});
		const listening = server;
		await new Promise<void>((done) => listening.listen(path, done));
		return path;
	}

	it("asks for sessions alone, and hears the state and each change", async () => {
		const socket = await node([
			{ Ok: "Watching" },
			{ SessionsChanged: { sessions: [session("a", "one")] } },
		]);
		const { events, said } = told();
		const feed = watchSessions(socket, FILES, events);
		await vi.waitFor(() => expect(said).toEqual(["put a.json one", "ready"]));
		expect(asks, "a watch naming no groups").toEqual([
			`${line({ Watch: { recent: 0 } })}\n`,
		]);
		clients[0]?.write(`${line({ SessionForgotten: { id: "a" } })}\n`);
		await vi.waitFor(() => expect(said.at(-1)).toBe("gone a.json"));
		feed.close();
		expect(said, "a close it asked for ends nothing").not.toContain(
			"ended lost",
		);
	});

	it("is lost when the node goes", async () => {
		const socket = await node([{ Ok: "Watching" }]);
		const { events, said } = told();
		watchSessions(socket, FILES, events);
		await vi.waitFor(() => expect(clients.length).toBe(1));
		clients[0]?.destroy();
		await vi.waitFor(() => expect(said).toEqual(["ended lost"]));
	});

	it("is lost where no node listens", async () => {
		const { events, said } = told();
		watchSessions(join(dir, "none.sock"), FILES, events);
		await vi.waitFor(() => expect(said).toEqual(["ended lost"]));
	});
});
