/**
 * Orchestration: which quest's session a quest answers to.
 */
import { describe, expect, it } from "vitest";
import { orchestrationOf } from "../../../lib/internal/quest/orchestration.ts";
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
