/**
 * Sending into another realm through the node, along the flows it has,
 * and a message that crossed in from one, which nothing here answers.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shortId } from "../../../lib/mesh/message.ts";
import { stopPresent } from "../../../lib/mesh/present.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import {
	fixture,
	fromElsewhere,
	ownBoard,
	peer,
	send,
	startSession,
} from "./support/mesh.ts";

/** What a stand-in node for the realm `personal` heard, and where it serves. */
interface RealmNode {
	/** Each Send it was asked, as asked. */
	readonly sends: Record<string, unknown>[];
	/** How many times it was asked its flows. */
	asked: number;
	/** The environment that names it to a session. */
	readonly env: NodeJS.ProcessEnv;
}

const realmServers: Server[] = [];

/**
 * A stand-in node for the realm `personal`, counting the session
 * present, answering `"Flows"` with `flows` and each Send with what
 * `sending` says to it.
 */
async function realmNode(
	flows: unknown,
	sending: (asked: Record<string, unknown>) => unknown = (asked) => ({
		Ok: {
			Sent: {
				id: `1-${String(asked.from)}-1-0000beef`,
				at: new Date().toISOString(),
				from: asked.from,
				groups: asked.groups,
				intent: asked.intent,
				text: asked.text,
				fromRealm: "personal",
			},
		},
	}),
): Promise<RealmNode> {
	const runtime = join(fixture.root, "run");
	mkdirSync(join(runtime, "mycelium"), { recursive: true });
	const heard: RealmNode = {
		sends: [],
		asked: 0,
		env: { MYCELIUM_REALM: "personal", XDG_RUNTIME_DIR: runtime },
	};
	const server = createServer((client) => {
		client.setEncoding("utf8");
		client.on("data", (chunk: string) => {
			for (const line of chunk.split("\n").filter(Boolean)) {
				const asked: unknown = JSON.parse(line);
				let reply: unknown = { Err: "not a request" };
				if (asked === "Present") reply = { Ok: "Present" };
				if (asked === "Flows") {
					heard.asked += 1;
					reply = flows;
				}
				const send = (asked as { Send?: Record<string, unknown> }).Send;
				if (send) {
					heard.sends.push(send);
					reply = sending(send);
				}
				client.write(`${JSON.stringify(reply)}\n`);
			}
		});
	});
	realmServers.push(server);
	await new Promise<void>((listening) =>
		server.listen(join(runtime, "mycelium", "personal.sock"), listening),
	);
	return heard;
}

/** Send through the tool with every parameter given, answering its words. */
async function sendWith(
	tools: Awaited<ReturnType<typeof startSession>>["tools"],
	params: Record<string, unknown>,
): Promise<{ text: string; details: unknown }> {
	const answer = (await tools.get("mesh_send")?.execute("call-1", params)) as
		| { content: { text: string }[]; details: unknown }
		| undefined;
	return { text: answer?.content[0]?.text ?? "", details: answer?.details };
}

const flowing = (...to: string[]) => ({ Ok: { Flows: { to } } });

describe("a send into another realm", () => {
	afterEach(async () => {
		stopPresent();
		await Promise.all(
			realmServers
				.splice(0)
				.map((server) => new Promise((done) => server.close(done))),
		);
	});

	it("goes through the node along a flow it has, leaving nothing in this realm's mesh", async () => {
		const node = await realmNode(flowing("work"));
		const { tools } = await startSession(node.env);

		const { text, details } = await sendWith(tools, {
			to: "4uhc5q",
			intent: "finding",
			text: "the flow holds",
			realm: "work",
		});

		expect(node.sends).toEqual([
			{
				from: "7M6JKG",
				groups: ["peer.4uhc5q"],
				intent: "finding",
				text: "the flow holds",
				realm: "work",
			},
		]);
		expect(text).toContain(
			"Sent to the work realm as 7M6JKG: [0000beef] finding to @4UHC5Q: the flow holds",
		);
		expect(details).toMatchObject({
			sent: true,
			crossed: { fromRealm: "personal" },
		});
		expect(folderTransport(join(fixture.paths.mesh, "messages")).ids()).toEqual([]);
	});

	it("is refused here when the node has no flow to that realm, naming those it has", async () => {
		const node = await realmNode(flowing("work"));
		const { tools } = await startSession(node.env);

		const { text } = await sendWith(tools, {
			to: "4uhc5q",
			intent: "fyi",
			text: "hello",
			realm: "lab",
		});

		expect(text).toContain(
			"Not sent: this realm's node has no flow to lab, so nothing sent here reaches it. Its node lets it send to work: pass that as realm",
		);
		expect(node.sends).toEqual([]);
	});

	it("takes a node that doesn't know flows for one with none, sending nothing across", async () => {
		// Today's node answers a request it doesn't know with an error.
		const node = await realmNode({
			Err: "not a request: unknown variant `Flows`",
		});
		const { tools } = await startSession(node.env);

		const { text } = await sendWith(tools, {
			to: "4uhc5q",
			intent: "fyi",
			text: "hello",
			realm: "work",
		});

		expect(text).toContain("Its node lets it send to no other realm.");
		expect(node.sends).toEqual([]);
	});

	it("hands the node's refusal back to the sender with its why", async () => {
		const node = await realmNode(flowing("work"), () => ({
			Refused: { code: "unheard", why: "no session in work goes by 4UHC5Q" },
		}));
		const { tools } = await startSession(node.env);

		const { text, details } = await sendWith(tools, {
			to: "4uhc5q",
			intent: "question",
			text: "ready?",
			realm: "work",
		});

		expect(text).toBe(
			"Not sent: the node refused it (unheard): no session in work goes by 4UHC5Q",
		);
		expect(details).toMatchObject({
			sent: false,
			crossRefused: { code: "unheard" },
		});
	});

	it("says which realms it may send to when an address nobody here goes by is refused", async () => {
		const node = await realmNode(flowing("work"));
		const { tools } = await startSession(node.env);

		const answer = await send(tools, "4uhc5q", "fyi", "hello");

		expect(answer).toContain(
			"Not sent: no session in this realm goes by 4UHC5Q",
		);
		expect(answer).toContain(
			"This realm's node lets it send to work: if it is meant for a session there, send it again with realm set to that realm.",
		);
		expect(node.sends).toEqual([]);
	});

	it("leaves a send without realm in this realm, as before", async () => {
		const node = await realmNode(flowing("work"));
		peer("session-p", ["P9R1KI"], []);
		const { tools } = await startSession(node.env);

		const answer = await send(tools, "p9r1ki", "fyi", "hello");

		expect(answer).toContain("Sent as 7M6JKG");
		expect(node.sends).toEqual([]);
		expect(folderTransport(join(fixture.paths.mesh, "messages")).ids()).toHaveLength(1);
	});
});

/** A message the node carried in from another realm, as it writes one. */
function crossedIn(over: Record<string, unknown> = {}): string {
	const id = `${Date.now()}-4UHC5Q-1-0000cafe`;
	const dir = join(fixture.paths.mesh, "messages");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${id}.json`),
		JSON.stringify({
			v: 1,
			id,
			at: new Date().toISOString(),
			from: "4UHC5Q",
			to: ["@7M6JKG"],
			intent: "question",
			text: "can the harness read this?",
			pid: 1,
			fromRealm: "work",
			...over,
		}),
	);
	return id;
}

describe("a message that crossed from another realm", () => {
	it("reaches its reader with the realm it came from, told it can't be answered", async () => {
		const { sent } = await startSession();

		crossedIn();

		await vi.waitFor(() =>
			expect(
				sent.find(({ message }) => message.content.includes("can the harness"))
					?.message.content,
			).toContain("from 4UHC5Q in the work realm to @7M6JKG"),
		);
		const content =
			sent.find(({ message }) => message.content.includes("can the harness"))
				?.message.content ?? "";
		expect(content).toContain(
			"It crossed from the work realm, which nothing said here reaches, so it can't be answered on the mesh",
		);
	});

	it("is never answered on the mesh, by id or as the question this peer took up", async () => {
		const { sent, tools } = await startSession();
		const id = crossedIn();
		await vi.waitFor(() =>
			expect(sent.map(({ message }) => message.content)).toContainEqual(
				expect.stringContaining("can the harness"),
			),
		);

		const named = await sendWith(tools, {
			intent: "fyi",
			text: "yes",
			re: shortId({ id }),
		});

		expect(named.text).toContain(
			"Not sent: [0000cafe] crossed from the work realm, and nothing said on the mesh reaches back there",
		);
		expect(
			folderTransport(join(fixture.paths.mesh, "messages")).ids(),
			"nothing written beside what crossed in",
		).toEqual([id]);
		expect(
			ownBoard().filter((lease) => lease.kind === "answer"),
			"no answer is taken up for it",
		).toEqual([]);
	});

	it("is kept from everyone here while it waits to cross elsewhere", async () => {
		// A machine that doesn't cross stores a send for another realm until
		// a link carries it to one that does; it is no message of this realm.
		const { sent } = await startSession();

		crossedIn({ fromRealm: undefined, forRealm: "work", text: "for work" });
		fromElsewhere({ to: ["@7M6JKG"], text: "after it" });

		await vi.waitFor(() =>
			expect(sent.map(({ message }) => message.content)).toContainEqual(
				expect.stringContaining("after it"),
			),
		);
		expect(sent.map(({ message }) => message.content)).not.toContainEqual(
			expect.stringContaining("for work"),
		);
	});
});
