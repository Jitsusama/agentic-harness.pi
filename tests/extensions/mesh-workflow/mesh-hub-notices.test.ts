/**
 * What the mesh says by itself on a quest with no orchestrator mark: an
 * ending and a session on no model are told to the hub from use this
 * peer keeps, and a question for the person's hands sent to the hub by
 * its address is counted as one sent with the word.
 */

import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUEST_CONCLUDED } from "../../../lib/internal/quest/fields/concluded.ts";
import { SESSION_ON_NO_MODEL } from "../../../lib/internal/session/no-model.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import { fixture, onQuest, send, startSession } from "./support/mesh.ts";
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

/** The parent quest's cell, 5GV2AH, live above the fixture's quest. */
function parentLive() {
	createPresences(join(fixture.paths.mesh, "presence")).publish({
		session: "session-q",
		addresses: ["5GV2AH"],
		groups: ["#quest/5gv2ah"],
		joined: [],
		quest: "QEST-20261021-5GV2AH",
		worksOn: "",
		owns: [],
		busy: false,
		at: new Date().toISOString(),
	});
}

/** What has been sent on the mesh, oldest first. */
function sent() {
	const transport = folderTransport(join(fixture.paths.mesh, "messages"));
	return transport.ids().map((id) => transport.read(id));
}

/**
 * Start the fixture's session, tied to the live parent cell, and wait
 * until the ending it is told proves the hub is kept: each try before
 * then sends nothing, as nobody is above yet.
 */
async function keptHub() {
	onQuest();
	parentLive();
	const env = await node([asker], [tieTo("5GV2AH", 4)]);
	const started = await startSession(env);
	await vi.waitFor(() => {
		started.emit(QUEST_CONCLUDED, {
			how: "concluded",
			ids: ["PLAN-20261021-AAAAAA"],
			said: "Now concluded on plan PLAN-20261021-AAAAAA (The Plan).",
		});
		expect(sent().at(-1)).toMatchObject({ to: ["@5GV2AH"], intent: "fyi" });
	});
	return started;
}

describe("the mesh's own word, on a quest with no mark", () => {
	it("tells the hub from use when a quest or document ends", async () => {
		await keptHub();

		expect(sent()).toHaveLength(1);
		expect(sent()[0]?.text).toContain("PLAN-20261021-AAAAAA concluded");
	});

	it("tells the hub from use, as a finding, that its session is on no model", async () => {
		const { emit } = await keptHub();

		emit(SESSION_ON_NO_MODEL, { when: "before a turn" });

		expect(sent().at(-1)).toMatchObject({
			to: ["@5GV2AH"],
			intent: "finding",
		});
		expect(sent().at(-1)?.text).toContain("on no model");
	});

	it("counts the person's acts in a question for his hands sent to the hub by its address", async () => {
		const { tools } = await keptHub();

		const refused = await send(
			tools,
			"5GV2AH",
			"question",
			"May Joel touch the key at 02:00?",
		);

		expect(refused).toContain("Not sent: this asks for the person's hands");
		expect(sent()).toHaveLength(1);
	});
});
