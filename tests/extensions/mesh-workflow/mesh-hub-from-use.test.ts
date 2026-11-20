/**
 * `orchestrator` on a quest with no orchestrator mark: it reaches the
 * hub from use, the live cell on a quest above this one that its ties
 * are strongest to, and says so; with no such cell it refuses, naming
 * the quest, and never sends wider.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import {
	fixture,
	noNode,
	onQuest,
	peer,
	send,
	startSession,
} from "./support/mesh.ts";
import { closeNodes, node } from "./support/node.ts";

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

/** The last message on the mesh, as the transport keeps it. */
function lastSent() {
	const transport = folderTransport(join(fixture.paths.mesh, "messages"));
	return transport.read(transport.ids().at(-1) ?? "");
}

describe("orchestrator, on a quest with no mark", () => {
	it("reaches the hub from use above this peer's quest, and says it was read so", async () => {
		onQuest();
		peer("session-q", ["5GV2AH"], ["#quest/5gv2ah"]);
		peer("session-h", ["HARN01"], ["#harness"]);
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

	it("still reaches the marked orchestrator over a stronger tie elsewhere above", async () => {
		onQuest();
		writeFileSync(
			join(fixture.paths.quests, "QEST-20261021-5GV2AH", "README.md"),
			"---\nid: QEST-20261021-5GV2AH\nkind: quest\nparent: null\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\norchestrator: true\n---\n# QEST-20261021-5GV2AH\n",
		);
		peer("session-q", ["5GV2AH"], ["#quest/5gv2ah"]);
		peer("session-w", ["WIDE01"], ["#quest/5gv2ah"]);
		const env = await node(
			[asker, { key: "cell:5GV2AH" }, { key: "cell:WIDE01" }],
			[tieTo("WIDE01", 9)],
		);
		const { tools } = await startSession(env);

		const answer = await send(tools, "orchestrator", "fyi", "Landed.");

		expect(lastSent()).toMatchObject({ to: ["@5GV2AH"] });
		expect(answer).not.toContain("hub from use");
	});

	it("refuses, naming the quest, when no live cell above is tied to this peer", async () => {
		onQuest();
		peer("session-q", ["5GV2AH"], ["#quest/5gv2ah"]);
		peer("session-h", ["HARN01"], ["#harness"]);
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
		peer("session-q", ["5GV2AH"], ["#quest/5gv2ah"]);
		const { tools } = await startSession(noNode());

		const refused = await send(tools, "orchestrator", "question", "May I?");

		expect(refused).toContain("no node answered");
		expect(lastSent()).toBeUndefined();
	});
});
