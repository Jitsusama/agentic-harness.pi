/**
 * A session heading an orchestration keeps the node told what it
 * orchestrates: claimed when it changes, said again once due, forgotten
 * once no orchestrating quest is loaded or once a refusal leaves an old
 * one held, never asked in a pile while the node is slow, and never
 * silenced by one ask that throws.
 *
 * Long because every case drives the one keeper through the same fake
 * clock and node, each a way an ask can land, fail or race another;
 * split, each half would rebuild that clock and node.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CLAIM_END_WAIT_MS,
	CLAIM_LOOKED_AGAIN_MS,
	CLAIM_RETRIED_AFTER_START_MS,
	CLAIM_TICK_MS,
	type ClaimKeeperDeps,
	claimKeeper,
	keepOrchestrationClaimed,
} from "../../../../extensions/quest-workflow/orchestration/claim.ts";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { installHost } from "../../../../lib/core/session/host.ts";
import { clearDiscoveryCache } from "../../../../lib/internal/quest/discovery/discovery.ts";
import { PARKING } from "../../../../lib/internal/session/park.ts";
import type {
	ClaimPlace,
	ClaimTold,
	OrchestrationClaim,
} from "../../../../lib/mesh/orchestrates.ts";

const MISSION = "QEST-20260101-MISSON";
const LOOP = "QEST-20260101-LOOPQQ";
const DONE = "QEST-20260101-DONEQQ";
const NESTED = "QEST-20260101-NESTED";
const WORKER = "QEST-20260101-WORKER";
const PLAIN = "QEST-20260101-PLAINQ";
const OTHER = "QEST-20260101-OTHERQ";
const ENDED = "QEST-20260101-ENDEDQ";

const RECORDED: ClaimTold = { kind: "recorded" };
const REFUSED: ClaimTold = { kind: "refused", why: "another session heads it" };
const TIMED_OUT: ClaimTold = {
	kind: "unasked",
	why: "mycelium answered nothing in 20 s",
	mayLand: true,
};

const MISSION_CLAIM = { heads: MISSION, quests: [LOOP, NESTED] };

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

/** One ask the node was sent. */
interface Ask {
	readonly claim: OrchestrationClaim | "forget";
	readonly session: string;
	readonly realm?: string;
	readonly place?: ClaimPlace;
}

/**
 * A keeper over a fresh state whose node answers each ask with `answer`,
 * keeping each ask and each line said.
 */
function keeping(
	answer: ClaimTold | ((ask: Ask) => ClaimTold | Promise<ClaimTold>) = RECORDED,
	overrides: Partial<ClaimKeeperDeps> = {},
) {
	const state = createQuestState({ questsRoot: root });
	const asked: Ask[] = [];
	const said: string[] = [];
	let clock = 0;
	const deps: ClaimKeeperDeps = {
		tell: async (claim, session, realm, place) => {
			const ask = { claim, session, realm, place };
			asked.push(ask);
			return typeof answer === "function" ? answer(ask) : answer;
		},
		realm: () => "work",
		now: () => clock,
		journal: (line) => said.push(line),
		...overrides,
	};
	return {
		state,
		asked,
		claims: () => asked.map((one) => one.claim),
		claimsOnly: () => asked.filter((one) => one.claim !== "forget"),
		said,
		keeper: claimKeeper(state, deps),
		pass: (ms: number) => {
			clock += ms;
		},
	};
}

/** A promise held open until `release` is called with what it answers. */
function held<T>() {
	let release: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

const AT: ClaimPlace = {};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "orchestration-claim-"));
	clearDiscoveryCache();
	quest(MISSION, { orchestrator: true });
	quest(LOOP, { parent: MISSION });
	quest(DONE, { parent: MISSION, status: "concluded" });
	quest(NESTED, { parent: MISSION, orchestrator: true });
	quest(WORKER, { parent: NESTED });
	quest(PLAIN, {});
	quest(OTHER, { orchestrator: true });
	quest(ENDED, { orchestrator: true, status: "concluded" });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	clearDiscoveryCache();
});

describe("an orchestrator's claim", () => {
	it("names the quest it heads and each open quest it is nearest above", async () => {
		const { state, asked, keeper } = keeping();
		state.questId = MISSION;

		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(
			asked.map(({ claim, session }) => ({ claim, session })),
			"one claim, for the session that looked",
		).toEqual([{ claim: MISSION_CLAIM, session: "sess-1" }]);
	});

	it("isn't asked again while nothing it claims has changed", async () => {
		const { state, asked, keeper } = keeping();
		state.questId = MISSION;

		keeper.look("sess-1", AT);
		await keeper.settled();
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(
			asked,
			"the second look finds the claim already recorded",
		).toHaveLength(1);
	});

	it("is asked again when a quest below it is made", async () => {
		const { state, asked, keeper } = keeping();
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();

		const MADE = "QEST-20260102-MADEQQ";
		quest(MADE, { parent: MISSION });
		clearDiscoveryCache();
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(asked.at(-1)?.claim, "the new quest joins the claim").toEqual({
			heads: MISSION,
			quests: [LOOP, NESTED, MADE],
		});
	});

	it("is forgotten once the session loads a quest that orchestrates nothing", async () => {
		const { state, claims, keeper } = keeping();
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		state.questId = PLAIN;
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(claims(), "a claim, then its forget").toEqual([
			MISSION_CLAIM,
			"forget",
		]);
	});

	it("is forgotten while the loaded orchestrator has ended, so another may head it", async () => {
		const { state, claims, keeper } = keeping();
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		state.questId = ENDED;
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(claims(), "a concluded orchestrator was claimed").toEqual([
			MISSION_CLAIM,
			"forget",
		]);
	});

	it("never lets a forget overtake a claim still waiting on the node", async () => {
		const slow = held<ClaimTold>();
		const { state, claims, keeper } = keeping((ask) =>
			ask.claim === "forget" ? RECORDED : slow.promise,
		);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await Promise.resolve();
		state.questId = PLAIN;
		keeper.look("sess-1", AT);
		await Promise.resolve();

		expect(claims(), "the forget waits for the claim's answer").toEqual([
			MISSION_CLAIM,
		]);
		slow.release(RECORDED);
		await keeper.settled();
		expect(claims(), "then goes, after it").toEqual([MISSION_CLAIM, "forget"]);
	});

	it("asks once more, not once a look, while the node is slow", async () => {
		const slow = held<ClaimTold>();
		let first = true;
		const { state, asked, keeper, pass } = keeping(() => {
			if (!first) return RECORDED;
			first = false;
			return slow.promise;
		});
		state.questId = MISSION;
		keeper.lookIfDue("sess-1", AT);
		// Each look is due, so each would say the claim again on its own.
		for (let looked = 0; looked < 20; looked += 1) {
			pass(CLAIM_LOOKED_AGAIN_MS);
			keeper.lookIfDue("sess-1", AT);
		}
		slow.release(TIMED_OUT);
		await keeper.settled();

		expect(
			asked,
			"twenty due looks behind a slow ask become one more ask",
		).toHaveLength(2);
	});

	it("asks a hung node once, however many looks pile up behind it", async () => {
		const slow = held<ClaimTold>();
		const { state, asked, keeper } = keeping(() => slow.promise);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		for (let looked = 0; looked < 20; looked += 1) keeper.look("sess-1", AT);
		slow.release(TIMED_OUT);
		await keeper.settled();

		expect(
			asked,
			"the one waiting waits out the failed ask until due",
		).toHaveLength(1);
	});

	it("asks for the quest loaded as a waiting ask runs, not as it looked", async () => {
		const slow = held<ClaimTold>();
		let first = true;
		const { state, claims, keeper } = keeping(() => {
			if (!first) return RECORDED;
			first = false;
			return slow.promise;
		});
		state.questId = OTHER;
		keeper.look("sess-1", AT);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		state.questId = NESTED;
		slow.release(RECORDED);
		await keeper.settled();

		expect(
			claims(),
			"a quest put down before its ask ran is never claimed",
		).toEqual([
			{ heads: OTHER, quests: [] },
			{ heads: NESTED, quests: [WORKER] },
		]);
	});

	it("forgets once at the start of a session with nothing to claim, then never", async () => {
		const { state, claims, keeper } = keeping();
		state.questId = PLAIN;
		keeper.look("sess-1", AT);
		await keeper.settled();
		state.questId = null;
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(
			claims(),
			"one forget, for a claim made before this keeper, then nothing to forget",
		).toEqual(["forget"]);
	});

	it("forgets a claim that timed out, since it may have reached the node", async () => {
		const { state, claims, keeper } = keeping((ask) =>
			ask.claim === "forget" ? RECORDED : TIMED_OUT,
		);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		state.questId = PLAIN;
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(claims(), "the claim, then a forget all the same").toEqual([
			MISSION_CLAIM,
			"forget",
		]);
	});

	it("says a claim again after one that timed out, though it matches the last recorded", async () => {
		const MADE = "QEST-20260102-MADEQQ";
		const { state, claims, keeper } = keeping((ask) =>
			ask.claim !== "forget" && ask.claim.quests.includes(MADE)
				? TIMED_OUT
				: RECORDED,
		);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		quest(MADE, { parent: MISSION });
		clearDiscoveryCache();
		keeper.look("sess-1", AT);
		await keeper.settled();
		rmSync(join(root, MADE), { recursive: true });
		clearDiscoveryCache();
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(
			claims(),
			"the node may hold the claim that timed out, so the first is said again",
		).toEqual([
			MISSION_CLAIM,
			{ heads: MISSION, quests: [LOOP, NESTED, MADE] },
			MISSION_CLAIM,
		]);
	});

	it("forgets the quest it headed when the node refuses the next", async () => {
		const { state, claims, keeper } = keeping((ask) =>
			ask.claim !== "forget" && ask.claim.heads === OTHER ? REFUSED : RECORDED,
		);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		state.questId = OTHER;
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(
			claims(),
			"a refusal changes nothing at the node, so the old claim is let go",
		).toEqual([MISSION_CLAIM, { heads: OTHER, quests: [] }, "forget"]);
	});

	it("waits out a refusal and says it once, though the forget after it was recorded", async () => {
		const { state, claims, said, keeper } = keeping((ask) =>
			ask.claim !== "forget" && ask.claim.heads === OTHER ? REFUSED : RECORDED,
		);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		state.questId = OTHER;
		keeper.look("sess-1", AT);
		await keeper.settled();
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(
			claims(),
			"the refused claim isn't asked again at once",
		).toHaveLength(3);
		expect(said, "and its refusal is said once").toHaveLength(1);
	});

	it("forgets an earlier session's claim of the quest the node refuses it, then claims", async () => {
		let refused = false;
		const { state, asked, keeper } = keeping((ask) => {
			if (ask.claim === "forget" || ask.session !== "sess-2" || refused)
				return RECORDED;
			refused = true;
			return REFUSED;
		});
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		keeper.look("sess-2", AT);
		await keeper.settled();

		expect(
			asked.map(({ claim, session }) => [claim, session]),
			"the old session's claim is let go, and this one claims at once",
		).toEqual([
			[MISSION_CLAIM, "sess-1"],
			[MISSION_CLAIM, "sess-2"],
			["forget", "sess-1"],
			[MISSION_CLAIM, "sess-2"],
		]);
	});

	it("still lets go of the quest it headed when the forget after a refusal timed out", async () => {
		let forgets = 0;
		const { state, claims, keeper, pass } = keeping((ask) => {
			if (ask.claim === "forget") {
				forgets += 1;
				return forgets === 1 ? TIMED_OUT : RECORDED;
			}
			return ask.claim.heads === OTHER ? REFUSED : RECORDED;
		});
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		state.questId = OTHER;
		keeper.look("sess-1", AT);
		await keeper.settled();
		pass(CLAIM_LOOKED_AGAIN_MS);
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(
			claims(),
			"the node may still hold the first quest, so it is forgotten again",
		).toEqual([
			MISSION_CLAIM,
			{ heads: OTHER, quests: [] },
			"forget",
			{ heads: OTHER, quests: [] },
			"forget",
		]);
	});

	it("waits out a refusal and says it once, though the forget after it failed", async () => {
		const { state, claims, said, keeper } = keeping((ask) => {
			if (ask.claim === "forget") return TIMED_OUT;
			return ask.claim.heads === OTHER ? REFUSED : RECORDED;
		});
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		state.questId = OTHER;
		keeper.look("sess-1", AT);
		await keeper.settled();
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(
			claims(),
			"neither the refused claim nor its forget is asked again at once",
		).toEqual([MISSION_CLAIM, { heads: OTHER, quests: [] }, "forget"]);
		expect(said, "the refusal and the forget each said once").toHaveLength(2);
	});

	it("forgets what it held before and asks once more soon, when refused before any answer", async () => {
		let claimsAsked = 0;
		const { state, claims, keeper, pass } = keeping((ask) => {
			if (ask.claim === "forget") return RECORDED;
			claimsAsked += 1;
			return claimsAsked === 1 ? REFUSED : RECORDED;
		});
		state.questId = MISSION;
		keeper.look("sess-2", AT);
		await keeper.settled();
		keeper.lookIfDue("sess-2", AT);
		await keeper.settled();
		expect(
			claims(),
			"a predecessor's forget may be on its way, so not again at once",
		).toEqual([MISSION_CLAIM, "forget"]);

		pass(CLAIM_RETRIED_AFTER_START_MS);
		keeper.lookIfDue("sess-2", AT);
		await keeper.settled();
		expect(claims(), "asked once more soon after").toEqual([
			MISSION_CLAIM,
			"forget",
			MISSION_CLAIM,
		]);
	});

	it("asks soon after a refusal at the start only once, however its forget is answered", async () => {
		const { state, claimsOnly, keeper, pass } = keeping((ask) =>
			ask.claim === "forget"
				? { kind: "unasked", why: "connecting to the node: refused" }
				: REFUSED,
		);
		state.questId = MISSION;
		keeper.look("sess-2", AT);
		await keeper.settled();
		for (const _ of [1, 2, 3]) {
			pass(CLAIM_RETRIED_AFTER_START_MS);
			keeper.lookIfDue("sess-2", AT);
			await keeper.settled();
		}

		expect(
			claimsOnly(),
			"the second refusal is the node's own word, waited out",
		).toHaveLength(2);
	});

	it("asks soon once more when its first claim is refused after a start's forget", async () => {
		let claimsAsked = 0;
		const { state, claims, keeper, pass } = keeping((ask) => {
			if (ask.claim === "forget") return RECORDED;
			claimsAsked += 1;
			return claimsAsked === 1 ? REFUSED : RECORDED;
		});
		keeper.look("sess-2", AT);
		await keeper.settled();
		state.questId = MISSION;
		keeper.lookIfDue("sess-2", AT);
		await keeper.settled();
		pass(CLAIM_RETRIED_AFTER_START_MS);
		keeper.lookIfDue("sess-2", AT);
		await keeper.settled();

		expect(
			claims(),
			"a quest loaded late is still the first claim, so its refusal is retried soon, forgetting nothing twice",
		).toEqual(["forget", MISSION_CLAIM, MISSION_CLAIM]);
	});

	it("asks a claim at once after the forget before it failed", async () => {
		const { state, claims, keeper } = keeping((ask) =>
			ask.claim === "forget" ? TIMED_OUT : RECORDED,
		);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		state.questId = PLAIN;
		keeper.look("sess-1", AT);
		await keeper.settled();
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(
			claims(),
			"a failed forget waits on its own, never holding back the claim after it",
		).toEqual([MISSION_CLAIM, "forget", MISSION_CLAIM]);
	});

	it("sends nothing after a refusal that lands as the session stops", async () => {
		const slow = held<ClaimTold>();
		const { state, asked, keeper } = keeping((ask) =>
			ask.claim === "forget" ? RECORDED : slow.promise,
		);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		keeper.stop();
		slow.release(REFUSED);
		await keeper.settled();

		expect(
			asked.map(({ claim }) => claim),
			"no forget follows, which could undo a reloaded keeper's claim",
		).toEqual([MISSION_CLAIM]);
	});

	it("forgets a claim that timed out under the session that asked it", async () => {
		const { state, asked, keeper } = keeping((ask) =>
			ask.claim === "forget" ? RECORDED : TIMED_OUT,
		);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		state.questId = PLAIN;
		keeper.look("sess-2", AT);
		await keeper.settled();

		expect(asked.at(-1), "the node may hold it under sess-1").toMatchObject({
			claim: "forget",
			session: "sess-1",
		});
	});

	it("still lets go of the quest it headed when a claim that timed out is refused", async () => {
		let otherAsks = 0;
		const { state, claims, keeper, pass } = keeping((ask) => {
			if (ask.claim === "forget" || ask.claim.heads !== OTHER) return RECORDED;
			otherAsks += 1;
			return otherAsks === 1 ? TIMED_OUT : REFUSED;
		});
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		state.questId = OTHER;
		keeper.look("sess-1", AT);
		await keeper.settled();
		pass(CLAIM_LOOKED_AGAIN_MS);
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(
			claims(),
			"the first quest is still held, so the refusal lets it go",
		).toEqual([
			MISSION_CLAIM,
			{ heads: OTHER, quests: [] },
			{ heads: OTHER, quests: [] },
			"forget",
		]);
	});

	it("keeps the quest it heads when a claim of that quest is refused", async () => {
		const MADE = "QEST-20260102-MADEQQ";
		const { state, claims, keeper } = keeping((ask) =>
			ask.claim !== "forget" && ask.claim.quests.includes(MADE)
				? REFUSED
				: RECORDED,
		);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		quest(MADE, { parent: MISSION });
		clearDiscoveryCache();
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(
			claims(),
			"a quest below refused leaves its head claimed, forgetting nothing",
		).toEqual([
			MISSION_CLAIM,
			{ heads: MISSION, quests: [LOOP, NESTED, MADE] },
		]);
	});

	it("forgets under the session that claimed, if the session changed", async () => {
		const { state, asked, keeper } = keeping();
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		state.questId = PLAIN;
		keeper.look("sess-2", AT);
		await keeper.settled();

		expect(asked.at(-1), "the forget names who holds the claim").toMatchObject({
			claim: "forget",
			session: "sess-1",
		});
	});

	it("waits until due to ask again what the node refused", async () => {
		const { state, claimsOnly, keeper, pass } = keeping((ask) =>
			ask.claim === "forget" ? RECORDED : REFUSED,
		);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		keeper.look("sess-1", AT);
		await keeper.settled();
		expect(
			claimsOnly(),
			"a refused claim is not asked again at once",
		).toHaveLength(1);

		pass(CLAIM_LOOKED_AGAIN_MS);
		keeper.look("sess-1", AT);
		await keeper.settled();
		expect(claimsOnly(), "it is asked again once due").toHaveLength(2);
	});

	it("is asked at a turn's start only once it is due, or the quest changed", async () => {
		const { state, asked, keeper, pass } = keeping();
		state.questId = MISSION;
		keeper.lookIfDue("sess-1", AT);
		await keeper.settled();
		keeper.lookIfDue("sess-1", AT);
		await keeper.settled();
		expect(asked, "not again before it is due").toHaveLength(1);

		pass(CLAIM_LOOKED_AGAIN_MS);
		keeper.lookIfDue("sess-1", AT);
		await keeper.settled();
		expect(
			asked,
			"said again once due, though unchanged, in case the node let it lapse",
		).toHaveLength(2);

		state.questId = NESTED;
		keeper.lookIfDue("sess-1", AT);
		await keeper.settled();
		expect(
			asked.at(-1)?.claim,
			"a quest loaded since is claimed at once",
		).toEqual({ heads: NESTED, quests: [WORKER] });
	});

	it("says the claim again a period after it was sent, though a quest action looked between", async () => {
		const { state, claimsOnly, keeper, pass } = keeping();
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		pass(CLAIM_LOOKED_AGAIN_MS - 60_000);
		keeper.look("sess-1", AT);
		await keeper.settled();
		pass(60_000);
		keeper.lookIfDue("sess-1", AT);
		await keeper.settled();

		expect(
			claimsOnly(),
			"a look that sent nothing put off saying it again no further",
		).toHaveLength(2);
	});

	it("asks a failing forget again a period after it was sent, not each minute", async () => {
		const { state, claims, keeper, pass } = keeping((ask) =>
			ask.claim === "forget" ? TIMED_OUT : RECORDED,
		);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		pass(60_000);
		state.questId = PLAIN;
		keeper.lookIfDue("sess-1", AT);
		await keeper.settled();
		for (let minute = 0; minute < 6; minute += 1) {
			pass(CLAIM_TICK_MS);
			keeper.lookIfDue("sess-1", AT);
			await keeper.settled();
		}

		expect(
			claims(),
			"the forget sent at a minute is asked again at six, and not before",
		).toEqual([MISSION_CLAIM, "forget", "forget"]);
	});

	it("reads the quests once a period when a due look finds nothing to send", async () => {
		let looked = 0;
		const { state, claims, keeper, pass } = keeping(RECORDED, {
			realm: () => {
				looked += 1;
				return "work";
			},
		});
		state.questId = PLAIN;
		keeper.lookIfDue("sess-1", AT);
		await keeper.settled();
		const atStart = looked;
		for (let minute = 0; minute < 11; minute += 1) {
			pass(CLAIM_TICK_MS);
			keeper.lookIfDue("sess-1", AT);
			await keeper.settled();
		}

		expect(claims(), "the one forget at the start").toEqual(["forget"]);
		// Each due look names the realm twice: as it comes due, and as it asks.
		expect(
			looked - atStart,
			"looked again at five minutes and at ten, not each minute",
		).toBe(4);
	});

	it("says the claim within a minute of the node coming back, not a period on", async () => {
		let served = true;
		const { state, claimsOnly, keeper, pass } = keeping(RECORDED, {
			realm: () => (served ? "work" : undefined),
		});
		state.questId = MISSION;
		keeper.lookIfDue("sess-1", AT);
		await keeper.settled();
		served = false;
		pass(CLAIM_LOOKED_AGAIN_MS);
		keeper.lookIfDue("sess-1", AT);
		await keeper.settled();
		served = true;
		pass(CLAIM_TICK_MS);
		keeper.lookIfDue("sess-1", AT);
		await keeper.settled();

		expect(
			claimsOnly(),
			"a look due while the node was gone put the claim off a period",
		).toHaveLength(2);
	});

	it("says a refusal once, however often it recurs", async () => {
		const { state, claimsOnly, said, keeper, pass } = keeping((ask) =>
			ask.claim === "forget" ? RECORDED : REFUSED,
		);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		pass(CLAIM_LOOKED_AGAIN_MS);
		keeper.lookIfDue("sess-1", AT);
		await keeper.settled();

		expect(claimsOnly(), "it was refused twice").toHaveLength(2);
		expect(said, "one line in the journal").toHaveLength(1);
		expect(said[0], "it says the node's words").toContain(
			"another session heads it",
		);
	});

	it("goes on asking after an ask that throws, saying what threw", async () => {
		let throws = true;
		const { state, asked, said, keeper } = keeping((ask) => {
			if (throws && ask.claim !== "forget") {
				throws = false;
				throw new Error("the node's socket went away");
			}
			return RECORDED;
		});
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		state.questId = OTHER;
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(said.join("\n"), "the throw is said").toContain(
			"the node's socket went away",
		);
		expect(asked.at(-1)?.claim, "the next look still asks").toEqual({
			heads: OTHER,
			quests: [],
		});
	});

	it("goes on asking after a realm that throws", async () => {
		let throws = true;
		const { state, asked, keeper } = keeping(RECORDED, {
			realm: () => {
				if (throws) {
					throws = false;
					throw new Error("no runtime folder");
				}
				return "work";
			},
		});
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(asked, "the second look asks").toHaveLength(1);
	});

	it("asks nothing more once the session stops", async () => {
		const slow = held<ClaimTold>();
		const { state, asked, keeper } = keeping(() => slow.promise);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		state.questId = PLAIN;
		keeper.look("sess-1", AT);
		keeper.stop();
		slow.release(RECORDED);
		await keeper.settled();
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(asked, "only the ask already sent").toHaveLength(1);
	});

	it("forgets as the conversation ends at once, beside the ask in flight", async () => {
		const slow = held<ClaimTold>();
		let first = true;
		const { state, asked, keeper } = keeping(() => {
			if (!first) return RECORDED;
			first = false;
			return slow.promise;
		});
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		keeper.end("sess-2", AT);
		await new Promise((resolve) => setImmediate(resolve));
		expect(
			asked.map(({ claim, session }) => [claim, session]),
			"the last forget goes before the claim is answered, under the session that asked it",
		).toEqual([
			[MISSION_CLAIM, "sess-1"],
			["forget", "sess-1"],
		]);

		slow.release(RECORDED);
		await keeper.settled();
		keeper.look("sess-1", AT);
		await keeper.settled();
		expect(asked, "then nothing").toHaveLength(2);
	});

	it("forgets nothing as it ends holding nothing", async () => {
		const { state, asked, keeper } = keeping();
		state.questId = PLAIN;
		keeper.look("sess-1", AT);
		await keeper.settled();
		keeper.end("sess-1", AT);
		await keeper.settled();

		expect(asked, "only the start's forget").toEqual([
			expect.objectContaining({ claim: "forget" }),
		]);
	});

	it("asks the node of the session's own environment", async () => {
		const realms: NodeJS.ProcessEnv[] = [];
		const { state, asked, keeper } = keeping(RECORDED, {
			realm: (env) => {
				realms.push(env);
				return env.MYCELIUM_REALM;
			},
		});
		state.questId = MISSION;
		const env = { MYCELIUM_REALM: "second", PATH: "/session/bin" };
		keeper.look("sess-1", { env });
		await keeper.settled();

		expect(realms, "the realm is the session's").toEqual([env]);
		expect(
			asked[0],
			"asked of that realm, with that environment",
		).toMatchObject({
			realm: "second",
			place: { env },
		});
	});

	it("asks nothing where no node serves, or no session is known", async () => {
		const { state, asked, keeper } = keeping();
		state.questId = MISSION;
		keeper.look(undefined, AT);
		await keeper.settled();
		expect(asked, "no session, no claim").toEqual([]);

		const none = keeping(RECORDED, { realm: () => undefined });
		none.state.questId = MISSION;
		none.keeper.look("sess-1", AT);
		await none.keeper.settled();
		expect(none.asked, "no node, no claim").toEqual([]);
	});
});

describe("the claim's wiring", () => {
	type Event = { toolName?: string; reason?: string };
	type Handler = (event: Event, ctx: unknown) => unknown;

	function wired(overrides: Partial<ClaimKeeperDeps> = {}) {
		const handlers = new Map<string, Handler>();
		const bus = new Map<string, (data: unknown) => void>();
		const pi = {
			on: (name: string, handler: Handler) => handlers.set(name, handler),
			events: {
				on: (name: string, listener: (data: unknown) => void) =>
					bus.set(name, listener),
			},
		};
		const state = createQuestState({ questsRoot: root });
		state.questId = MISSION;
		const asked: string[] = [];
		const asks: Ask[] = [];
		let clock = 0;
		let tick: (() => void) | undefined;
		let tickEvery: number | undefined;
		let ticking = false;
		const deps: ClaimKeeperDeps = {
			tell: async (claim, session, realm, place) => {
				asked.push(session);
				asks.push({ claim, session, realm, place });
				return RECORDED;
			},
			realm: () => "work",
			now: () => clock,
			journal: () => undefined,
			every: (look, ms) => {
				tick = look;
				tickEvery = ms;
				ticking = true;
				return () => {
					ticking = false;
				};
			},
			...overrides,
		};
		keepOrchestrationClaimed(pi as unknown as ExtensionAPI, state, deps);
		const ctx = (session: string) => ({
			cwd: "/",
			sessionManager: { getSessionId: () => session },
		});
		const fire = (name: string, event: Event, session: string) =>
			handlers.get(name)?.(event, ctx(session));
		const settle = () => new Promise((resolve) => setImmediate(resolve));
		return {
			handlers,
			asked,
			asks,
			fire,
			state,
			settle,
			say: (name: string, data: unknown) => bus.get(name)?.(data),
			pass: (ms: number) => {
				clock += ms;
			},
			tick: () => tick?.(),
			tickEvery: () => tickEvery,
			ticking: () => ticking,
		};
	}

	it("looks as the session starts, after a quest action and as a turn starts", () => {
		const { handlers } = wired();
		expect(
			[...handlers.keys()].sort(),
			"the events the claim is kept on",
		).toEqual(
			[
				"before_agent_start",
				"session_shutdown",
				"session_start",
				"tool_result",
			].sort(),
		);
	});

	it("claims at the start, and after a quest action but not another tool's", async () => {
		const { asked, fire, state } = wired();
		fire("session_start", {}, "sess-1");
		await new Promise((resolve) => setImmediate(resolve));
		expect(asked, "claimed as the session starts").toEqual(["sess-1"]);

		state.questId = OTHER;
		fire("tool_result", { toolName: "bash" }, "sess-1");
		await new Promise((resolve) => setImmediate(resolve));
		expect(asked, "another tool's result looks at nothing").toEqual(["sess-1"]);

		fire("tool_result", { toolName: "quest" }, "sess-1");
		await new Promise((resolve) => setImmediate(resolve));
		expect(asked, "a quest action looks again").toEqual(["sess-1", "sess-1"]);
	});

	it("says the claim again on a timer once due, with no turn to say it", async () => {
		const { asked, fire, settle, pass, tick, ticking } = wired();
		fire("session_start", {}, "sess-1");
		await settle();
		tick();
		await settle();
		expect(asked, "not before it is due").toEqual(["sess-1"]);

		pass(CLAIM_LOOKED_AGAIN_MS);
		tick();
		await settle();
		expect(asked, "said again by the timer alone").toEqual([
			"sess-1",
			"sess-1",
		]);

		fire("session_shutdown", { reason: "reload" }, "sess-1");
		expect(ticking(), "the timer stops as the session does").toBe(false);
	});

	it("ticks well inside the due period, so a claim is never a period late", () => {
		const { tickEvery } = wired();
		expect(tickEvery(), "a tick a minute").toBe(CLAIM_TICK_MS);
		expect(CLAIM_TICK_MS * 4, "several ticks to a period").toBeLessThanOrEqual(
			CLAIM_LOOKED_AGAIN_MS,
		);
	});

	it("hands pi the last forget to wait on as a conversation quits", async () => {
		const answer = held<ClaimTold>();
		let asks = 0;
		const { fire, settle } = wired({
			tell: (claim) => {
				asks += 1;
				return claim === "forget" ? answer.promise : Promise.resolve(RECORDED);
			},
		});
		fire("session_start", {}, "sess-1");
		await settle();
		let done = false;
		const ending = Promise.resolve(
			fire("session_shutdown", { reason: "quit" }, "sess-1"),
		).then(() => {
			done = true;
		});
		await settle();
		expect(asks, "the forget was sent").toBe(2);
		expect(done, "pi is still waiting on it").toBe(false);

		answer.release(RECORDED);
		await ending;
		expect(done, "and done once it is answered").toBe(true);
	});

	it("waits on a quit's last forget no longer than its cap", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const never = held<ClaimTold>();
			const { fire, settle } = wired({
				tell: (claim) =>
					claim === "forget" ? never.promise : Promise.resolve(RECORDED),
			});
			fire("session_start", {}, "sess-1");
			await settle();
			let done = false;
			const ending = Promise.resolve(
				fire("session_shutdown", { reason: "quit" }, "sess-1"),
			).then(() => {
				done = true;
			});
			await vi.advanceTimersByTimeAsync(CLAIM_END_WAIT_MS - 1);
			expect(done, "still waiting just short of the cap").toBe(false);

			await vi.advanceTimersByTimeAsync(1);
			await ending;
			expect(done, "a forget never answered holds pi no longer").toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("forgets as a conversation is swapped or quit, never on a reload or a park", async () => {
		const ends = async (reason: string, parked = false) => {
			const { asks, fire, settle, say } = wired();
			fire("session_start", {}, "sess-1");
			await settle();
			if (parked) say(PARKING, { session: "sess-1", addresses: [] });
			fire("session_shutdown", { reason }, "sess-1");
			await settle();
			return asks.map(({ claim }) => claim).at(-1) === "forget";
		};

		expect(await ends("new"), "a swap lets the claim go").toBe(true);
		expect(await ends("quit"), "so does a quit").toBe(true);
		expect(await ends("reload"), "a reload goes on as the same session").toBe(
			false,
		);
		expect(await ends("quit", true), "a parked session stays reachable").toBe(
			false,
		);
	});

	it("asks from a hosted session's own environment, not the host's", async () => {
		const own: NodeJS.ProcessEnv = { MYCELIUM_REALM: "second", PATH: "/own" };
		const uninstall = installHost({
			kind: "pi-durable",
			key: "test-claim",
			owner: { pid: process.pid, startedAt: 1 },
			holds: () => "idle",
			env: () => ({
				get: (key) => own[key],
				set: () => undefined,
				delete: () => undefined,
				snapshot: () => ({ ...own }),
			}),
			hints: () => ({}),
			close: () => undefined,
			stamp: () => undefined,
		});
		try {
			const { asks, fire, settle } = wired({
				realm: (env) => env.MYCELIUM_REALM,
			});
			fire("session_start", {}, "sess-1");
			await settle();

			expect(
				asks[0],
				"the session's realm, with its environment",
			).toMatchObject({ realm: "second", place: { env: own } });
		} finally {
			uninstall();
		}
	});
});
