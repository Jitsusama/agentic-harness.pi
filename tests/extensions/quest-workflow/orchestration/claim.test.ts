/**
 * A session heading an orchestration keeps the node told what it
 * orchestrates: claimed when it changes, not asked again when it
 * doesn't, and forgotten once no orchestrating quest is loaded.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CLAIM_LOOKED_AGAIN_MS,
	type ClaimKeeperDeps,
	claimKeeper,
} from "../../../../extensions/quest-workflow/orchestration-claim.ts";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { clearDiscoveryCache } from "../../../../lib/internal/quest/discovery/discovery.ts";
import type {
	ClaimTold,
	OrchestrationClaim,
} from "../../../../lib/mesh/orchestrates.ts";

const MISSION = "QEST-20260101-MISSON";
const LOOP = "QEST-20260101-LOOPQQ";
const DONE = "QEST-20260101-DONEQQ";
const NESTED = "QEST-20260101-NESTED";
const WORKER = "QEST-20260101-WORKER";
const PLAIN = "QEST-20260101-PLAINQ";

let root: string;

function quest(id: string, fields: Record<string, string | number | boolean>) {
	const all = { status: "active", rank: 1, ...fields };
	const kind = "parent" in fields ? "subquest" : "quest";
	const lines = Object.entries(all).map(([key, value]) => `${key}: ${value}`);
	mkdirSync(join(root, id), { recursive: true });
	writeFileSync(
		join(root, id, "README.md"),
		`---\nid: ${id}\nkind: ${kind}\npriority: active\nstarted: 2026-01-01\nupdated: 2026-01-01\n${lines.join("\n")}\n---\n\n# ${id}\n`,
	);
}

/** A keeper over a fresh state whose node answers `answer`, keeping each ask. */
function keeping(answer: ClaimTold = { kind: "recorded" }) {
	const state = createQuestState({ questsRoot: root });
	const asked: { claim: OrchestrationClaim | "forget"; session: string }[] = [];
	const said: string[] = [];
	let clock = 0;
	const deps: ClaimKeeperDeps = {
		tell: async (claim, session) => {
			asked.push({ claim, session });
			return answer;
		},
		realm: () => "work",
		now: () => clock,
		journal: (line) => said.push(line),
	};
	return {
		state,
		asked,
		said,
		keeper: claimKeeper(state, deps),
		pass: (ms: number) => {
			clock += ms;
		},
	};
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "orchestration-claim-"));
	clearDiscoveryCache();
	quest(MISSION, { orchestrator: true });
	quest(LOOP, { parent: MISSION });
	quest(DONE, { parent: MISSION, status: "concluded" });
	quest(NESTED, { parent: MISSION, orchestrator: true });
	quest(WORKER, { parent: NESTED });
	quest(PLAIN, {});
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	clearDiscoveryCache();
});

describe("an orchestrator's claim", () => {
	it("names the quest it heads and each open quest it is nearest above", async () => {
		const { state, asked, keeper } = keeping();
		state.questId = MISSION;

		keeper.look("sess-1", root);
		await keeper.settled();

		expect(asked, "one claim, for the session that looked").toEqual([
			{ claim: { heads: MISSION, quests: [LOOP, NESTED] }, session: "sess-1" },
		]);
	});

	it("isn't asked again while nothing it claims has changed", async () => {
		const { state, asked, keeper } = keeping();
		state.questId = MISSION;

		keeper.look("sess-1", root);
		keeper.look("sess-1", root);
		await keeper.settled();

		expect(
			asked,
			"the second look finds the claim already recorded",
		).toHaveLength(1);
	});

	it("is asked again when a quest below it is made", async () => {
		const { state, asked, keeper } = keeping();
		state.questId = MISSION;
		keeper.look("sess-1", root);
		await keeper.settled();

		const MADE = "QEST-20260102-MADEQQ";
		quest(MADE, { parent: MISSION });
		clearDiscoveryCache();
		keeper.look("sess-1", root);
		await keeper.settled();

		expect(asked.at(-1)?.claim, "the new quest joins the claim").toEqual({
			heads: MISSION,
			quests: [LOOP, NESTED, MADE],
		});
	});

	it("is forgotten once the session loads a quest that orchestrates nothing", async () => {
		const { state, asked, keeper } = keeping();
		state.questId = MISSION;
		keeper.look("sess-1", root);
		await keeper.settled();
		state.questId = PLAIN;
		keeper.look("sess-1", root);
		await keeper.settled();

		expect(
			asked.map((one) => one.claim),
			"a claim, then its forget, in order",
		).toEqual([{ heads: MISSION, quests: [LOOP, NESTED] }, "forget"]);
	});

	it("asks for the quest loaded as it asks, not as it looked", async () => {
		const { state, asked, keeper } = keeping();
		state.questId = MISSION;
		keeper.look("sess-1", root);
		state.questId = PLAIN;
		await keeper.settled();

		expect(
			asked,
			"a quest put down before the ask ran is never claimed",
		).toEqual([]);
	});

	it("is never asked for by a session that never claimed", async () => {
		const { state, asked, keeper } = keeping();
		state.questId = PLAIN;
		keeper.look("sess-1", root);
		state.questId = null;
		keeper.look("sess-1", root);
		await keeper.settled();

		expect(asked, "nothing to claim and nothing to forget").toEqual([]);
	});

	it("is asked at a turn's start only once it is due, or the quest changed", async () => {
		const { state, asked, keeper, pass } = keeping({
			kind: "refused",
			why: "another session heads it",
		});
		state.questId = MISSION;
		keeper.lookIfDue("sess-1", root);
		keeper.lookIfDue("sess-1", root);
		await keeper.settled();
		expect(asked, "a refused claim is not asked again at once").toHaveLength(1);

		pass(CLAIM_LOOKED_AGAIN_MS);
		keeper.lookIfDue("sess-1", root);
		await keeper.settled();
		expect(asked, "it is asked again once due").toHaveLength(2);

		state.questId = NESTED;
		keeper.lookIfDue("sess-1", root);
		await keeper.settled();
		expect(
			asked.at(-1)?.claim,
			"a quest loaded since is claimed at once",
		).toEqual({ heads: NESTED, quests: [WORKER] });
	});

	it("says a refusal once, however often it recurs", async () => {
		const { state, said, keeper, pass } = keeping({
			kind: "refused",
			why: "another session heads it",
		});
		state.questId = MISSION;
		keeper.look("sess-1", root);
		pass(CLAIM_LOOKED_AGAIN_MS);
		keeper.lookIfDue("sess-1", root);
		await keeper.settled();

		expect(said, "one line in the journal").toHaveLength(1);
		expect(said[0], "it says the node's words").toContain(
			"another session heads it",
		);
	});

	it("asks nothing where no node serves, or no session is known", async () => {
		const { state, asked, keeper } = keeping();
		state.questId = MISSION;
		keeper.look(undefined, root);
		await keeper.settled();
		expect(asked, "no session, no claim").toEqual([]);

		const none = claimKeeper(state, {
			tell: async (claim, session) => {
				asked.push({ claim, session });
				return { kind: "recorded" };
			},
			realm: () => undefined,
		});
		none.look("sess-1", root);
		await none.settled();
		expect(asked, "no node, no claim").toEqual([]);
	});
});
