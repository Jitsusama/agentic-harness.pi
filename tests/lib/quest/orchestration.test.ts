/**
 * Orchestration: which quest's session a quest answers to.
 */
import { describe, expect, it } from "vitest";
import {
	orchestrationOf,
	questsOrchestratedBy,
	windowWorkspaceOf,
} from "../../../lib/internal/quest/fields/orchestration.ts";
import type { QuestFrontMatter } from "../../../lib/quest/types.ts";

function quest(
	id: string,
	parent: string | null,
	over: Partial<QuestFrontMatter> = {},
): QuestFrontMatter {
	return {
		id,
		kind: parent ? "subquest" : "quest",
		parent,
		status: "active",
		priority: "active",
		rank: 1,
		started: "2026-10-25",
		updated: "2026-10-25",
		aliases: [],
		sessions: [],
		...over,
	};
}

function store(...quests: QuestFrontMatter[]) {
	const byId = new Map(quests.map((one) => [one.id, one]));
	return (id: string) => byId.get(id);
}

const MISSION = "QEST-20261007-WCJQSG";
const LOOP = "QEST-20261025-QCXZEB";
const SWARM = "QEST-20261026-SWARM1";
const WORKER = "QEST-20261026-WORKR1";
const KARST = "QEST-20260924-19AMVE";

describe("the person's steward", () => {
	it("is the nearest steward above, apart from the orchestrator", () => {
		const read = store(
			quest(MISSION, null, { orchestrator: true, steward: true }),
			quest(SWARM, MISSION, { orchestrator: true }),
			quest(WORKER, SWARM),
		);

		expect(orchestrationOf(WORKER, read)).toEqual({
			by: SWARM,
			steward: MISSION,
		});
	});

	it("is never the quest itself, which stewards instead", () => {
		const read = store(quest(MISSION, null, { steward: true }));

		expect(orchestrationOf(MISSION, read)).toEqual({ stewards: MISSION });
	});

	// A steward under an orchestrator ends the person's path itself: the
	// work hub above it still orders its work, but carries nothing of
	// the person's for it.
	it("is said of a steward under an orchestrator, beside the work hub", () => {
		const read = store(
			quest(MISSION, null, { orchestrator: true }),
			quest(SWARM, MISSION, { steward: true }),
		);

		expect(orchestrationOf(SWARM, read)).toEqual({
			by: MISSION,
			stewards: SWARM,
		});
	});

	it("is the nearer of two stewards", () => {
		const read = store(
			quest(MISSION, null, { steward: true }),
			quest(SWARM, MISSION, { steward: true }),
			quest(WORKER, SWARM),
		);

		expect(orchestrationOf(WORKER, read).steward).toBe(SWARM);
	});

	it("is not chained from a steward to the one above it", () => {
		const read = store(
			quest(MISSION, null, { steward: true }),
			quest(SWARM, MISSION, { steward: true }),
		);

		expect(orchestrationOf(SWARM, read)).toEqual({ stewards: SWARM });
	});

	// Written by hand as text, it is kept for config to name, and makes
	// no steward.
	it("is not a steward written by hand as text", () => {
		const read = store(
			quest(MISSION, null, { _extra: { steward: "yes" } }),
			quest(LOOP, MISSION),
		);

		expect(orchestrationOf(LOOP, read).steward).toBeUndefined();
	});

	it("ends at a loop of parents rather than walking it forever", () => {
		const read = store(quest(SWARM, WORKER), quest(WORKER, SWARM));

		expect(orchestrationOf(WORKER, read).steward).toBeUndefined();
	});
});

describe("a quest's orchestration", () => {
	it("is the nearest marked quest above it, with nothing wired", () => {
		const read = store(
			quest(MISSION, null, { orchestrator: true }),
			quest(LOOP, MISSION),
		);

		expect(orchestrationOf(LOOP, read)).toEqual({ by: MISSION });
	});

	it("reaches past unmarked quests between", () => {
		const middle = "QEST-20261025-MIDDLE";
		const read = store(
			quest(MISSION, null, { orchestrator: true }),
			quest(middle, MISSION),
			quest(LOOP, middle),
		);

		expect(orchestrationOf(LOOP, read)).toEqual({ by: MISSION });
	});

	it("is on its own with no marked quest above it", () => {
		expect(orchestrationOf(KARST, store(quest(KARST, null)))).toEqual({});
	});

	it("heads its own when marked, answering to the one above", () => {
		const read = store(
			quest(MISSION, null, { orchestrator: true }),
			quest(SWARM, MISSION, { orchestrator: true }),
			quest(WORKER, SWARM),
		);

		expect(orchestrationOf(SWARM, read)).toEqual({
			by: MISSION,
			heads: SWARM,
		});
		expect(orchestrationOf(MISSION, read)).toEqual({ heads: MISSION });
		expect(orchestrationOf(WORKER, read)).toEqual({ by: SWARM });
	});

	it("follows `orchestratedBy` over the walk, for work taken on from outside the tree", () => {
		const read = store(
			quest(MISSION, null, { orchestrator: true }),
			quest(KARST, null, { orchestratedBy: MISSION }),
			quest(WORKER, KARST),
		);

		expect(orchestrationOf(KARST, read)).toEqual({ by: MISSION });
		expect(orchestrationOf(WORKER, read)).toEqual({ by: MISSION });
	});

	it("ignores `orchestratedBy` naming a quest that does not orchestrate, and walks on", () => {
		const read = store(
			quest(MISSION, null, { orchestrator: true }),
			quest(KARST, null),
			quest(LOOP, MISSION, { orchestratedBy: KARST }),
		);

		expect(orchestrationOf(LOOP, read)).toEqual({ by: MISSION });
	});

	it("reads the mark from a README written by a parser that keeps it as an extra", () => {
		const read = store(
			quest(MISSION, null, { _extra: { orchestrator: true } }),
			quest(LOOP, MISSION),
		);

		expect(orchestrationOf(LOOP, read)).toEqual({ by: MISSION });
	});

	it("stops at a parent loop rather than walking forever", () => {
		const a = "QEST-20261025-AAAAAA";
		const b = "QEST-20261025-BBBBBB";
		const read = store(quest(a, b), quest(b, a));

		expect(orchestrationOf(a, read)).toEqual({});
	});
});

describe("the workspace a quest's session window opens on", () => {
	it("is the topmost orchestrator's, through a nested orchestration", () => {
		// 13 November: after a reboot, windows opened wherever niri put
		// them; each belongs with the orchestrator Joel steers it through.
		const read = store(
			quest(MISSION, null, { orchestrator: true }),
			quest(SWARM, MISSION, { orchestrator: true }),
			quest(WORKER, SWARM),
		);

		expect(windowWorkspaceOf(WORKER, read)).toBe(MISSION);
		expect(windowWorkspaceOf(SWARM, read)).toBe(MISSION);
		expect(windowWorkspaceOf(MISSION, read)).toBe(MISSION);
	});

	it("is the quest's own with no orchestrator above it", () => {
		expect(windowWorkspaceOf(KARST, store(quest(KARST, null)))).toBe(KARST);
	});

	it("is none for a quest it can't read", () => {
		expect(windowWorkspaceOf(KARST, store())).toBeUndefined();
	});
});

describe("the quests an orchestrator orchestrates", () => {
	it("are those it is nearest above, in order of id, and none past a nested one", () => {
		const read = store(
			quest(MISSION, null, { orchestrator: true }),
			quest(SWARM, MISSION, { orchestrator: true }),
			quest(WORKER, SWARM),
			quest(LOOP, MISSION),
			quest(KARST, null),
		);
		const all = [WORKER, LOOP, SWARM, MISSION, KARST];

		expect(
			questsOrchestratedBy(MISSION, all, read),
			"the mission heads the loop and the nested swarm, not the swarm's worker",
		).toEqual([LOOP, SWARM]);
		expect(
			questsOrchestratedBy(SWARM, all, read),
			"the swarm heads its own worker",
		).toEqual([WORKER]);
	});

	it("are none for a quest that isn't marked, or can't be read", () => {
		const read = store(quest(MISSION, null), quest(LOOP, MISSION));

		expect(
			questsOrchestratedBy(MISSION, [LOOP], read),
			"an unmarked quest orchestrates nothing",
		).toEqual([]);
		expect(
			questsOrchestratedBy(KARST, [LOOP], read),
			"a quest not found orchestrates nothing",
		).toEqual([]);
	});
});
