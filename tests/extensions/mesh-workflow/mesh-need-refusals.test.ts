/**
 * Whom a lost need's refusal says to ask: the cell above under a mark,
 * the hub from use or the hub kept while the node is quiet, which a send
 * to `orchestrator` reaches, and the census where nothing is above.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Local } from "../../../extensions/mesh-workflow/tools/local.ts";
import {
	ASK_WHO_OWNS_IT,
	FIND_NONE_FOUND,
	FIND_WHILE_QUIET,
	FIND_WHILE_UNLISTED,
	FIND_WHILE_UNREAD,
	FIND_WHO_OWNS_IT,
	needRead,
} from "../../../extensions/mesh-workflow/tools/need.ts";
import { QUEST_CONCLUDED } from "../../../lib/internal/quest/fields/concluded.ts";
import type { NeedRecord } from "../../../lib/mesh/need-route.ts";
import { createPresences, type Presence } from "../../../lib/mesh/presence.ts";
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
		expect(FIND_WHILE_UNLISTED).toMatch(/while the mesh doesn't list it yet/);
		expect(FIND_WHILE_UNLISTED).toMatch(/find the owner in mesh_groups/);
		expect(FIND_WHILE_UNLISTED).not.toMatch(/node is quiet/);
		expect(FIND_NONE_FOUND).toMatch(/find the owner in mesh_groups/);
		expect(FIND_NONE_FOUND).not.toMatch(/quiet|can be asked/);
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

	// Another live session signs with the quest's address and so plays its
	// head, leaving this one on the quest with no role: the head it would
	// write to is named, never orchestrator or mesh_groups (#2118's
	// council F19).
	it("names the head of its quest for a peer on it that doesn't play the head", async () => {
		questHeadedBy("7M6JKG");
		peer("session-a", ["7M6JKG"], ["#quest/7m6jkg"]);

		const said = await lostNeed();

		expect(said).toContain("Not sent: no word of its about");
		expect(said).toContain(
			"Not knowing who, ask 7M6JKG, the head of this peer's quest, who owns it: a question to 7M6JKG.",
		);
		expect(said).not.toContain(FIND_WHO_OWNS_IT);
		expect(said).not.toContain("question to orchestrator");
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
		const before = asks;

		const said = await fontsNeed(started.tools);

		expect(said).toContain("Not sent: no node answered");
		expect(said).toContain(HUB_NAMED);
		expect(said).not.toContain(FIND_WHO_OWNS_IT);
		expect(said).not.toContain(FIND_WHILE_QUIET);
		// The need's own ask alone: a node that gave it no answer isn't asked
		// again for a fresh hub, whose find would name the same kept one
		// (#2118's council F20).
		expect(asks, "no fresh find for a hub").toBe(before + 1);
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

	// The node answered the need, so a find for a hub that went unfinished,
	// with none kept, is no quiet node's: the refusal once blamed one
	// (#2118's council F16 and F27).
	it("says none was found, not that the node was quiet, when it answers the need but not the find", async () => {
		let asks = 0;
		let answering = false;
		const started = await underHub(() => {
			asks += 1;
			if (!answering) return new Promise(() => {});
			answering = false;
			return Promise.resolve();
		});
		// The session's own find at its start asks first and is held, so no
		// hub is kept; from here only the need's own ask for ties is answered.
		await vi.waitFor(() => expect(asks).toBeGreaterThan(0), {
			timeout: 5_000,
		});
		answering = true;

		const said = await fontsNeed(started.tools);

		expect(said).toContain("Not sent: no word of its about");
		expect(said).toContain(FIND_NONE_FOUND);
		expect(said).not.toContain(FIND_WHILE_QUIET);
		expect(said).not.toContain(HUB_NAMED);
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

/** A need the node answered as lost, no word of it held by any cell. */
const LOST_ON_WORDS: NeedRecord = {
	need: "8XK2PQ-lost",
	asker: "8XK2PQ",
	words: [],
	path: [],
	fit: null,
	at: 0,
	cells: 1,
};

/**
 * What needRead reads of a peer holding these roles, the presences as
 * `all` lists them, and the node answering the need with `found`. Only
 * the fields a lost need's refusal reads; the rest of a Local is never
 * touched.
 */
function holding(
	roles: { orchestrates?: string; questHeads?: string },
	all: () => Presence[],
	found: NeedRecord | undefined,
): Local {
	const peer = { session: "session-s", addresses: ["8XK2PQ"], ...roles };
	return {
		peer,
		presences: { all },
		need: vi.fn().mockResolvedValue(found),
	} as unknown as Local;
}

/** What a need about the launcher's fonts was refused with, from `at`. */
async function refusedAt(at: Local): Promise<string> {
	const read = await needRead(at, {
		to: "need",
		intent: "question",
		text: "Who keeps the launcher's fonts?",
		about: "fonts",
	});
	return "refused" in read ? (read.refused.content[0]?.text ?? "") : "";
}

describe("a lost need's refusal, by where this peer sits", () => {
	// Another session signs as the quest's head, so this one is on a quest
	// heading an orchestration with neither role, and is told its head.
	it("names the head of this peer's quest when another session leads it", async () => {
		const said = await refusedAt(
			holding({ questHeads: "7M6JKG" }, () => [], LOST_ON_WORDS),
		);

		expect(said).toContain("Not sent: no word of its about");
		expect(said).toContain(
			"Not knowing who, ask 7M6JKG, the head of this peer's quest, who owns it: a question to 7M6JKG.",
		);
		expect(said).not.toContain(FIND_WHO_OWNS_IT);
	});

	// A head keeps no hub, so with the node quiet nothing but its role says
	// nothing is above it; that it was quiet isn't the reason.
	it("tells a head nothing is above it while the node is quiet", async () => {
		const said = await refusedAt(
			holding({ orchestrates: "8XK2PQ" }, () => [], undefined),
		);

		expect(said).toContain("Not sent: no node answered");
		expect(said).toContain(FIND_WHO_OWNS_IT);
		expect(said).not.toContain(FIND_WHILE_QUIET);
	});

	it("says none was found when reading the presences fails during the find", async () => {
		const all = vi
			.fn<() => Presence[]>()
			.mockReturnValueOnce([])
			.mockImplementation(() => {
				throw new Error("EMFILE: too many open files");
			});

		const said = await refusedAt(holding({}, all, LOST_ON_WORDS));

		expect(all).toHaveBeenCalledTimes(2);
		expect(said).toContain("Not sent: no word of its about");
		expect(said).toContain(FIND_WHILE_UNREAD);
		expect(said).not.toContain(FIND_WHILE_QUIET);
		expect(said).not.toContain(FIND_WHO_OWNS_IT);
	});

	// The node answered the need, so a find left unfinished because the
	// mesh lists no presence for this peer says so, not that it was quiet.
	it("says the mesh doesn't list this peer yet when that leaves the find unfinished", async () => {
		const said = await refusedAt(holding({}, () => [], LOST_ON_WORDS));

		expect(said).toContain("Not sent: no word of its about");
		expect(said).toContain(FIND_WHILE_UNLISTED);
		expect(said).not.toContain(FIND_WHILE_QUIET);
		expect(said).not.toContain(FIND_WHO_OWNS_IT);
	});
});
