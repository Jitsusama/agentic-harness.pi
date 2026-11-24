/**
 * Sending to `need`: a message goes to the live cell that works on what
 * it is about, found over the node's ties, and is kept for the measure;
 * a need nothing within reach works on is refused, and passed to nobody
 * in its place.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ASK_WHO_OWNS_IT,
	NEED_GRANTS_NOTHING,
} from "../../../extensions/mesh-workflow/tools/need.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import { fixture, peer, startSession } from "./support/mesh.ts";
import { closeNodes, node } from "./support/node.ts";

afterEach(closeNodes);

/** The fixture's session, 7M6JKG, as the node keeps it. */
const asker = { key: "cell:7M6JKG", title: "A Web, Not a Funnel" };

/** Send through the session's mesh_send, answering its words. */
async function sending(
	tools: Awaited<ReturnType<typeof startSession>>["tools"],
	params: Record<string, unknown>,
): Promise<string> {
	const answer = await tools.get("mesh_send")?.execute("call-1", params);
	return answer?.content[0]?.text ?? "";
}

/**
 * A refusal is read at the moment a need fails, and the note's next step
 * is to ask whoever is above who owns it, so no refusal may say a need
 * never goes to an orchestrator. Naming whom to ask there is still free.
 */
function expectNoBarAbove(said: string): void {
	expect(said).not.toMatch(
		/never sent to an orchestrator|(goes|went) to no orchestrator/,
	);
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
		// A fit works on it, which is no grant: that comes from the person or
		// the peer whose quest holds the work, and the answer says how to see.
		expect(said).toContain(NEED_GRANTS_NOTHING);
		expect(NEED_GRANTS_NOTHING).toContain(
			"the person or from the work's owner: the peer whose own quest holds it (mesh_groups names each peer's own quest)",
		);
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

	it("is refused, and sent to nobody, when no cell works on any word of its about", async () => {
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

		expect(said).toContain("Not sent: no word of its about");
		expect(said, "whom to ask, not knowing who").toContain(ASK_WHO_OWNS_IT);
		expect(said).toContain("counted as lost and passed to nobody in its place");
		expectNoBarAbove(said);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		expect(transport.ids()).toEqual([]);
	});

	it("is refused, and sent to nobody, when no cell works on any word of its text", async () => {
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
		});

		expect(said).toContain("Not sent: no word of its text");
		expect(said, "whom to ask, not knowing who").toContain(ASK_WHO_OWNS_IT);
		expect(said).toContain("counted as lost and passed to nobody in its place");
		expectNoBarAbove(said);
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

		expect(said).toContain("Not sent: no live cell within three ties");
		expect(said, "whom to ask, not knowing who").toContain(ASK_WHO_OWNS_IT);
		expect(said).toContain("counted as lost and passed to nobody in its place");
		expectNoBarAbove(said);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		expect(transport.ids()).toEqual([]);
		expect(said).toContain("5HJZ8Z works on it but has ended");
		expect(said, "with no stopper, any peer may be named").toContain(
			"Name the peers it is for by address.",
		);
	});

	it("is refused, naming the owner that ended and the live cell found, when the owner worked on more of it", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[
				asker,
				{ key: "cell:J7XHQN", title: "Dates Delivery" },
				{ key: "cell:5HJZ8Z", title: "Delivery Lanes" },
			],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "When does the delivery land?",
			about: "dates delivery",
		});

		expect(said, "a live cell was found, so it never says none was").toContain(
			"Not sent: J7XHQN worked on more of dates delivery than 5HJZ8Z, the live cell found, but has ended, so it was not sent to a cell sharing less of it.",
		);
		expect(said).not.toContain("no live cell within three ties");
		expect(said).toContain("Name 5HJZ8Z or another peer it is for by address");
		expect(said).toContain(ASK_WHO_OWNS_IT);
		expectNoBarAbove(said);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		expect(transport.ids()).toEqual([]);
	});

	it("says which words of its about no cell works on, when it goes by the rest", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Does a carry keep its fonts?",
			about: "fonts carry",
		});

		expect(said).toContain("went to 5HJZ8Z");
		expect(said).toContain(
			"No cell works on fonts, so it found nobody and it was asked by carry alone.",
		);
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
		expect(said, "it points at another peer, not the one refusing").toContain(
			"Name another peer it is for by address",
		);
		expect(said, "whom to ask, not knowing who").toContain(ASK_WHO_OWNS_IT);
		expect(said, "it is there, so it never reads as ended").not.toContain(
			"has ended",
		);
	});

	it("finds a need through a cell that stopped this one, which never hears it", async () => {
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
		peer("session-d", ["0TUD09"], []);
		const env = await node(
			[
				asker,
				{ key: "cell:5HJZ8Z", title: "Carry a Session" },
				{ key: "cell:0TUD09", title: "Carry a Tree" },
			],
			[
				{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() },
				{ key: "tie:5HJZ8Z~0TUD09", strength: 3, heard: Date.now() },
			],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Does a carry keep its tree's network?",
			about: "carry",
		});

		expect(said, "0TUD09, one tie past the stopper").toContain(
			"went to 0TUD09",
		);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const [id] = transport.ids();
		expect(
			id && transport.read(id),
			"the stopper is never written to",
		).toMatchObject({
			to: ["@0TUD09"],
		});
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
		expect(said, "whom to ask, not knowing who").toContain(ASK_WHO_OWNS_IT);
		expect(said).toContain("passed to nobody in its place");
		expectNoBarAbove(said);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		expect(transport.ids()).toEqual([]);
	});

	// Every session reads mesh_send's description in its tool list, long
	// before any refusal, so it may no more bar asking above than they.
	it("is described in mesh_send's own words as passed to nobody, never as kept from above", async () => {
		const { tools } = await startSession();

		const tool: unknown = tools.get("mesh_send");
		const description =
			typeof tool === "object" &&
			tool !== null &&
			"description" in tool &&
			typeof tool.description === "string"
				? tool.description
				: "";

		expect(description).toContain("passed to nobody in its place");
		expectNoBarAbove(description);
	});
});
