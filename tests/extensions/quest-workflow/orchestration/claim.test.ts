/**
 * A session heading an orchestration keeps the node told what it
 * orchestrates: claimed when it changes, said again once due, forgotten
 * once no orchestrating quest is loaded or once a refusal leaves an old
 * one held, never asked in a pile while the node is slow, and never
 * silenced by one ask that throws.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CLAIM_LOOKED_AGAIN_MS,
	type ClaimKeeperDeps,
	claimKeeper,
	keepOrchestrationClaimed,
} from "../../../../extensions/quest-workflow/orchestration-claim.ts";
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

const AT = { cwd: "/" };

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

	it("forgets an earlier session's claim of the quest the node refuses it", async () => {
		let refusing = true;
		const { state, asked, keeper } = keeping((ask) =>
			ask.claim !== "forget" && ask.session === "sess-2" && refusing
				? REFUSED
				: RECORDED,
		);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		keeper.look("sess-2", AT);
		await keeper.settled();
		refusing = false;
		keeper.look("sess-2", AT);
		await keeper.settled();

		expect(
			asked.map(({ claim, session }) => [claim, session]),
			"the old session's claim is let go, and this one claims at the next look",
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
		const { state, asked, keeper, pass } = keeping(REFUSED);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		keeper.look("sess-1", AT);
		await keeper.settled();
		expect(asked, "a refused claim is not asked again at once").toHaveLength(1);

		pass(CLAIM_LOOKED_AGAIN_MS);
		keeper.look("sess-1", AT);
		await keeper.settled();
		expect(asked, "it is asked again once due").toHaveLength(2);
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

	it("says a refusal once, however often it recurs", async () => {
		const { state, said, keeper, pass } = keeping(REFUSED);
		state.questId = MISSION;
		keeper.look("sess-1", AT);
		await keeper.settled();
		pass(CLAIM_LOOKED_AGAIN_MS);
		keeper.lookIfDue("sess-1", AT);
		await keeper.settled();

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

	it("forgets as the conversation ends, once the ask in flight is done", async () => {
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
		slow.release(RECORDED);
		await keeper.settled();
		keeper.look("sess-1", AT);
		await keeper.settled();

		expect(
			asked.map(({ claim, session }) => [claim, session]),
			"one last forget, under the session the node holds, then nothing",
		).toEqual([
			[MISSION_CLAIM, "sess-1"],
			["forget", "sess-1"],
		]);
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

	it("asks the node of the session's own environment, from where it looked", async () => {
		const realms: NodeJS.ProcessEnv[] = [];
		const { state, asked, keeper } = keeping(RECORDED, {
			realm: (env) => {
				realms.push(env);
				return env.MYCELIUM_REALM;
			},
		});
		state.questId = MISSION;
		const env = { MYCELIUM_REALM: "second", PATH: "/session/bin" };
		keeper.look("sess-1", { cwd: "/session", env });
		await keeper.settled();

		expect(realms, "the realm is the session's").toEqual([env]);
		expect(
			asked[0],
			"asked of that realm, with that environment",
		).toMatchObject({
			realm: "second",
			place: { cwd: "/session", env },
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
	type Handler = (event: Event, ctx: unknown) => void;

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
			every: (look) => {
				tick = look;
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
