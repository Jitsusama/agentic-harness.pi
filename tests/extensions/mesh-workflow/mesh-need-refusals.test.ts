/**
 * Whom a lost need's refusal says to ask: the cell above under a mark,
 * the hub from use or the hub kept while the node is quiet, which a send
 * to `orchestrator` reaches, and the census where nothing is above.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ASK_WHO_OWNS_IT,
	FIND_WHILE_QUIET,
	FIND_WHO_OWNS_IT,
} from "../../../extensions/mesh-workflow/tools/need.ts";
import { QUEST_CONCLUDED } from "../../../lib/internal/quest/fields/concluded.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import { fixture, onQuest, peer, startSession } from "./support/mesh.ts";
import { asker, expectNoBarAbove, sending } from "./support/need.ts";
import { closeNodes, node } from "./support/node.ts";

afterEach(closeNodes);

/**
 * The fixture's quest, 7M6JKG, under 5GV2AH, with `orchestrator: true` on
 * whichever of the two heads an orchestration.
 */
function questHeadedBy(head: "5GV2AH" | "7M6JKG"): void {
	for (const [id, parent] of [
		["QEST-20261021-7M6JKG", "QEST-20261021-5GV2AH"],
		["QEST-20261021-5GV2AH", "null"],
	] as const) {
		const heads = id.endsWith(head) ? "orchestrator: true\n" : "";
		mkdirSync(join(fixture.paths.quests, id), { recursive: true });
		writeFileSync(
			join(fixture.paths.quests, id, "README.md"),
			`---\nid: ${id}\nkind: quest\nparent: ${parent}\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\n${heads}---\n# ${id}\n`,
		);
	}
}

/** A lost need from the fixture's session, and what its refusal said. */
async function lostNeed(): Promise<string> {
	peer("session-c", ["5HJZ8Z"], []);
	const env = await node(
		[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
		[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
	);
	const { tools } = await startSession(env);
	return sending(tools, {
		to: "need",
		intent: "question",
		text: "Who keeps the launcher's fonts?",
		about: "fonts",
	});
}

describe("a lost need's refusal", () => {
	// Each refusal is checked against these words once, so the five below
	// stay true to a rewording and can't pass on an empty sentence.
	it("says to ask by a question, and to find the owner where nothing is above", () => {
		expect(ASK_WHO_OWNS_IT).toMatch(
			/ask the cell above .* a question to orchestrator/,
		);
		expect(FIND_WHO_OWNS_IT).toMatch(/find the owner in mesh_groups/);
		expect(FIND_WHO_OWNS_IT).toMatch(/ask it by address/);
		expect(FIND_WHILE_QUIET).toMatch(/could be found while the node is quiet/);
		expect(FIND_WHILE_QUIET).toMatch(/find the owner in mesh_groups/);
		expect(FIND_WHILE_QUIET).not.toMatch(/can be asked/);
	});

	it("points at orchestrator when a mark names one above", async () => {
		questHeadedBy("5GV2AH");

		const said = await lostNeed();

		expect(said).toContain("Not sent: no word of its about");
		expect(said).toContain(ASK_WHO_OWNS_IT);
		expect(said).not.toContain(FIND_WHO_OWNS_IT);
	});

	it("never points at orchestrator for a peer heading its own orchestration", async () => {
		questHeadedBy("7M6JKG");

		const said = await lostNeed();

		expect(said).toContain("Not sent: no word of its about");
		expect(said).toContain(FIND_WHO_OWNS_IT);
		expect(said).not.toContain("question to orchestrator");
		expect(said).not.toContain("the head of this peer's quest");
		expectNoBarAbove(said);
		// The head was recognised, not merely given no roles at all.
		const self = createPresences(join(fixture.paths.mesh, "presence"))
			.all()
			.find((one) => one.addresses.includes("7M6JKG"));
		expect(self?.orchestrates).toBe("7M6JKG");
	});

	// Under no mark, 5GV2AH's cell above is this peer's hub from use, which
	// `orchestrator` reaches, so the refusal names it rather than saying
	// nothing is above.
	it("names the hub from use above this peer, as orchestrator would reach it", async () => {
		const { tools } = await underHub(() => Promise.resolve());

		const said = await fontsNeed(tools);

		expect(said).toContain("Not sent: no word of its about");
		expect(said).toContain(HUB_NAMED);
		expect(said).not.toContain(FIND_WHO_OWNS_IT);
		expect(said).not.toContain(FIND_WHILE_QUIET);
		expect(said).not.toContain("question to orchestrator");
	}, 15_000);

	// The node went quiet after this peer kept 5GV2AH as its hub, which a
	// send to `orchestrator` still reaches, so the refusal names it too.
	it("names the hub this peer keeps when no node answers the need", async () => {
		let asks = 0;
		const started = await underHub(() => {
			asks += 1;
			return asks === 1 ? Promise.resolve() : new Promise(() => {});
		});
		await untilHubKept(started.emit);

		const said = await fontsNeed(started.tools);

		expect(said).toContain("Not sent: no node answered");
		expect(said).toContain(HUB_NAMED);
		expect(said).not.toContain(FIND_WHO_OWNS_IT);
		expect(said).not.toContain(FIND_WHILE_QUIET);
	}, 15_000);

	// The node answered the need, then left the refusal's own find for a hub
	// unfinished; the hub this peer keeps is read for it, as a send reads it.
	it("names the hub this peer keeps when the node answers the need but not the find", async () => {
		let asks = 0;
		let answered = 1;
		const started = await underHub(() => {
			asks += 1;
			return asks <= answered ? Promise.resolve() : new Promise(() => {});
		});
		await untilHubKept(started.emit);
		// Only the need's own ask for ties is answered from here.
		answered = asks + 1;

		const said = await fontsNeed(started.tools);

		expect(said).toContain("Not sent: no word of its about");
		expect(said).toContain(HUB_NAMED);
		expect(said).not.toContain(FIND_WHILE_QUIET);
	}, 15_000);
});

/** What a refusal says to ask the fixture's hub from use, 5GV2AH. */
const HUB_NAMED =
	"Not knowing who, ask 5GV2AH, the cell above this peer, who owns it: a question to 5GV2AH.";

/**
 * The fixture's session on 7M6JKG under 5GV2AH, with no mark, and
 * 5GV2AH's cell live on its own quest and tied to it, so it is the
 * session's hub from use; the node holds each ask for ties on `held`.
 */
async function underHub(held: () => Promise<unknown>) {
	onQuest();
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
	const env = await node(
		[asker, { key: "cell:5GV2AH" }],
		[
			{
				key: "tie:7M6JKG~5GV2AH",
				strength: 2,
				heard: Date.now(),
				hour: [1, 1],
				today: [2, 2],
			},
		],
		held,
	);
	return startSession(env);
}

/** A need about the launcher's fonts, which no cell works on. */
function fontsNeed(
	tools: Awaited<ReturnType<typeof startSession>>["tools"],
): Promise<string> {
	return sending(tools, {
		to: "need",
		intent: "question",
		text: "Who keeps the launcher's fonts?",
		about: "fonts",
	});
}

/**
 * Wait until the session keeps 5GV2AH as its hub, as seen by a quest's
 * ending reaching it, which the mesh tells only the hub it keeps.
 */
async function untilHubKept(
	emit: (event: string, payload: unknown) => void,
): Promise<void> {
	const transport = folderTransport(join(fixture.paths.mesh, "messages"));
	await vi.waitFor(
		() => {
			emit(QUEST_CONCLUDED, {
				how: "concluded",
				ids: ["PLAN-20261021-AAAAAA"],
				said: "Now concluded on plan PLAN-20261021-AAAAAA (The Plan).",
			});
			expect(transport.read(transport.ids().at(-1) ?? "")).toMatchObject({
				to: ["@5GV2AH"],
				intent: "fyi",
			});
		},
		{ timeout: 5_000 },
	);
}
