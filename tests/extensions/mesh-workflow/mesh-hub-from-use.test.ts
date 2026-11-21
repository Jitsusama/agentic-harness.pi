/**
 * `orchestrator` on a quest with no orchestrator mark: it reaches the
 * hub from use, the live cell on a quest above this one that it talks
 * with most, and says so; with no such cell it refuses, naming
 * the quest, and never sends wider.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import {
	fixture,
	noNode,
	onQuest,
	send,
	startSession,
} from "./support/mesh.ts";
import { closeNodes, node, nodeAsked } from "./support/node.ts";

afterEach(closeNodes);

/** The fixture's session, 7M6JKG, as the node keeps it. */
const asker = { key: "cell:7M6JKG", title: "QEST-20261021-7M6JKG" };

/** A tie from the fixture's session to `other`, heard just now. */
const tieTo = (other: string, strength: number) => ({
	key: `tie:7M6JKG~${other}`,
	strength,
	heard: Date.now(),
	hour: [1, 1],
	today: [strength, strength],
});

/**
 * A live peer whose work puts it in these groups, as a presence written
 * today says it: none of them joined, and on its own quest when given.
 */
function cellIn(
	session: string,
	address: string,
	groups: string[],
	quest?: string,
) {
	createPresences(join(fixture.paths.mesh, "presence")).publish({
		session,
		addresses: [address],
		groups,
		joined: [],
		...(quest ? { quest } : {}),
		worksOn: "",
		owns: [],
		busy: false,
		at: new Date().toISOString(),
	});
}

/** The fixture's parent quest, 5GV2AH, given the orchestrator mark. */
function markedParent() {
	writeFileSync(
		join(fixture.paths.quests, "QEST-20261021-5GV2AH", "README.md"),
		"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-5GV2AH\n",
	);
}

/** The last message on the mesh, as the transport keeps it. */
function lastSent() {
	const transport = folderTransport(join(fixture.paths.mesh, "messages"));
	return transport.read(transport.ids().at(-1) ?? "");
}

describe("orchestrator, on a quest with no mark", () => {
	it("reaches the hub from use above this peer's quest, and says it was read so", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		cellIn("session-h", "HARN01", ["#harness"]);
		const env = await node(
			[asker, { key: "cell:5GV2AH" }, { key: "cell:HARN01" }],
			[tieTo("HARN01", 9), tieTo("5GV2AH", 2)],
		);
		const { tools } = await startSession(env);

		const answer = await send(tools, "orchestrator", "question", "May I?");

		expect(answer).toContain(
			"`orchestrator` was read as 5GV2AH, this peer's hub from use",
		);
		expect(lastSent()).toMatchObject({ to: ["@5GV2AH"], text: "May I?" });
	});

	it("counts the person's acts in a question for his hands put to the hub", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"]);
		const env = await node([asker], [tieTo("5GV2AH", 2)]);
		const { tools } = await startSession(env);

		const refused = await send(
			tools,
			"orchestrator",
			"question",
			"May Joel touch the key at 02:00?",
		);

		expect(refused).toContain("Not sent: this asks for the person's hands");
		expect(lastSent()).toBeUndefined();
	});

	it("still reaches the marked orchestrator over a stronger tie, without asking the node", async () => {
		onQuest();
		markedParent();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"]);
		cellIn("session-w", "WIDE01", ["#quest/5gv2ah"]);
		const env = await node(
			[asker, { key: "cell:5GV2AH" }, { key: "cell:WIDE01" }],
			[tieTo("WIDE01", 9)],
		);
		const { tools } = await startSession(env);
		nodeAsked.length = 0;

		const answer = await send(tools, "orchestrator", "fyi", "Landed.");

		expect(lastSent()).toMatchObject({ to: ["@5GV2AH"] });
		expect(answer).not.toContain("hub from use");
		expect(nodeAsked).not.toContain("tie");
	});

	it("refuses, naming the quest, when no live cell above is tied to this peer", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"]);
		cellIn("session-h", "HARN01", ["#harness"]);
		const env = await node([asker], [tieTo("HARN01", 9)]);
		const { tools } = await startSession(env);

		const refused = await send(tools, "orchestrator", "question", "May I?");

		expect(refused).toContain(
			"Not sent: no orchestrator is above this peer's quest, QEST-20261021-7M6JKG, and no live cell on a quest above it has a tie to this peer yet",
		);
		expect(lastSent()).toBeUndefined();
	});

	it("refuses when no node answers, rather than sending wider", async () => {
		onQuest();
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"]);
		const { tools } = await startSession(noNode());

		const refused = await send(tools, "orchestrator", "question", "May I?");

		expect(refused).toContain(
			"no ties came from the node (none answered in time, or it keeps none)",
		);
		expect(lastSent()).toBeUndefined();
	});

	it("refuses for the head of an orchestration, without asking the node", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-7M6JKG", "README.md"),
			"---\nid: QEST-20261021-7M6JKG\nkind: quest\nparent: QEST-20261021-5GV2AH\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-7M6JKG\n",
		);
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		const env = await node([asker], [tieTo("5GV2AH", 9)]);
		const { tools } = await startSession(env);
		nodeAsked.length = 0;

		const refused = await send(tools, "orchestrator", "question", "May I?");

		expect(refused).toContain(
			"Not sent: this peer heads its own orchestration",
		);
		expect(lastSent()).toBeUndefined();
		expect(nodeAsked).not.toContain("tie");
	});

	it("refuses for another session on a quest heading an orchestration, naming its head", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-7M6JKG", "README.md"),
			"---\nid: QEST-20261021-7M6JKG\nkind: quest\nparent: QEST-20261021-5GV2AH\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-7M6JKG\n",
		);
		// The head already signs as the quest, so this session leaves the
		// address to it and plays no role.
		cellIn(
			"session-h",
			"7M6JKG",
			["#quest/5gv2ah/7m6jkg"],
			"QEST-20261021-7M6JKG",
		);
		cellIn("session-q", "5GV2AH", ["#quest/5gv2ah"], "QEST-20261021-5GV2AH");
		const env = await node([asker], [tieTo("5GV2AH", 9)]);
		const { tools } = await startSession(env);
		nodeAsked.length = 0;

		const refused = await send(tools, "orchestrator", "question", "May I?");

		expect(refused).toContain(
			"Not sent: this peer's quest heads its own orchestration, whose head is 7M6JKG",
		);
		// The mesh's own note that two sessions share the quest is on the
		// mesh already; only the refused question must not be.
		expect(lastSent()?.text).not.toBe("May I?");
		expect(nodeAsked).not.toContain("tie");
	});

	it("refuses when all that is beside the word cannot be a group", async () => {
		onQuest();
		const { tools } = await startSession(noNode());

		const refused = await send(
			tools,
			"orchestrator, not a group!",
			"question",
			"May I?",
		);

		expect(refused).toContain(
			"Not sent: no orchestrator is above this peer's quest",
		);
		expect(lastSent()).toBeUndefined();
	});
});
