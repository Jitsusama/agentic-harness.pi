/**
 * Sending to `need`: a message goes to the live cell that works on what
 * it is about, found over the node's ties, and is kept for the measure;
 * a need nothing within reach works on is refused, never sent to a
 * leader in its place.
 */

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import { fixture, peer, startSession } from "./support/mesh.ts";

let servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.map((server) => new Promise((done) => server.close(done))),
	);
	servers = [];
});

/** The fixture's session, 7M6JKG, as the node keeps it. */
const asker = { key: "cell:7M6JKG", title: "A Web, Not a Funnel" };

/**
 * A node for the realm `work` under the fixture's runtime folder,
 * listing these cells and ties and holding no hubs; the environment a
 * session reaches it by.
 */
async function node(cells: object[], ties: object[]) {
	const runtime = join(fixture.root, "run");
	mkdirSync(join(runtime, "mycelium"), { recursive: true });
	const server = createServer((client) => {
		client.setEncoding("utf8");
		let said = "";
		client.on("data", (chunk: string) => {
			said += chunk;
			for (let end = said.indexOf("\n"); end >= 0; end = said.indexOf("\n")) {
				const ask = JSON.parse(said.slice(0, end));
				said = said.slice(end + 1);
				const records =
					ask.kind === "cell" ? cells : ask.kind === "tie" ? ties : undefined;
				const reply =
					ask.ask === "list" && records
						? { id: ask.id, records }
						: { id: ask.id, error: { code: "unknown-kind" } };
				client.write(`${JSON.stringify(reply)}\n`);
			}
		});
	});
	servers.push(server);
	await new Promise<void>((listening) =>
		server.listen(join(runtime, "mycelium", "work.sock"), listening),
	);
	return { MYCELIUM_REALM: "work", XDG_RUNTIME_DIR: runtime };
}

/** Send through the session's mesh_send, answering its words. */
async function sending(
	tools: Awaited<ReturnType<typeof startSession>>["tools"],
	params: Record<string, unknown>,
): Promise<string> {
	const answer = await tools.get("mesh_send")?.execute("call-1", params);
	return answer?.content[0]?.text ?? "";
}

describe("sending to a need", () => {
	it("goes to the live cell along the ties that works on it, and is kept", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[
				asker,
				{ key: "cell:5HJZ8Z", title: "Carry a Session", repo: "mycelium" },
			],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Does a carry keep its tree's network?",
			about: "carry",
		});

		expect(said).toContain("Sent as 7M6JKG");
		expect(said).toContain("went to 5HJZ8Z");
		expect(said).toContain("a yes, ruling or grant still comes only from");
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const [id] = transport.ids();
		expect(id && transport.read(id)).toMatchObject({
			to: ["@5HJZ8Z"],
			intent: "question",
		});
		const [day] = readdirSync(join(fixture.paths.mesh, "needs"));
		const kept = JSON.parse(
			readFileSync(join(fixture.paths.mesh, "needs", day ?? ""), "utf8"),
		);
		expect(kept).toMatchObject({
			asker: "7M6JKG",
			words: ["carry"],
			path: ["5HJZ8Z"],
			fit: "5HJZ8Z",
		});
	});

	it("is refused, and sent to nobody, when no live cell works on it", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Who keeps the launcher's fonts?",
			about: "fonts",
		});

		expect(said).toContain("Not sent");
		expect(said).toContain("counted as lost, never sent to an orchestrator");
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		expect(transport.ids()).toEqual([]);
	});

	it("keeps only the text's words a cell works on when about is left out", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		await sending(tools, {
			to: "need",
			intent: "fyi",
			text: `The carry failed with ghp_${"Ab3".repeat(14)} in its log.`,
		});

		const [day] = readdirSync(join(fixture.paths.mesh, "needs"));
		const file = readFileSync(
			join(fixture.paths.mesh, "needs", day ?? ""),
			"utf8",
		);
		expect(JSON.parse(file)).toMatchObject({ words: ["carry"] });
		expect(file).not.toContain("ghp");
		expect(file.toLowerCase()).not.toContain("ab3ab3");
	});

	it("takes no cell the node keeps that isn't on the mesh now, and names it", async () => {
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Does a carry keep its tree's network?",
			about: "carry",
		});

		expect(said).toContain("Not sent");
		expect(said).toContain("5HJZ8Z works on it but has ended");
	});

	it("takes no cell that stopped this one, since it can't be written to", async () => {
		createPresences(join(fixture.paths.mesh, "presence")).publish({
			session: "session-c",
			addresses: ["5HJZ8Z"],
			groups: [],
			worksOn: "",
			owns: [],
			busy: false,
			stops: [{ address: "7M6JKG", at: new Date().toISOString() }],
			at: new Date().toISOString(),
		});
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Does a carry keep its tree's network?",
			about: "carry",
		});

		expect(said).toContain("Not sent");
		expect(said).toContain("counted as lost");
		expect(said, "it names who works on it and why not").toContain(
			"5HJZ8Z works on it but stopped this peer",
		);
		expect(said, "it is there, so it never reads as ended").not.toContain(
			"has ended",
		);
	});

	it("never crosses into another realm", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "fyi",
			text: "The carry note is up.",
			about: "carry",
			realm: "home",
		});

		expect(said).toContain("Not sent");
		expect(said).toContain("can't cross into another");
	});

	it("is refused when no node answers", async () => {
		const { tools } = await startSession({
			MYCELIUM_REALM: "work",
			XDG_RUNTIME_DIR: join(fixture.root, "nowhere"),
		});

		const said = await sending(tools, {
			to: "need",
			intent: "fyi",
			text: "The carry note is up.",
			about: "carry",
		});

		expect(said).toContain("Not sent: no node answered");
	});
});
