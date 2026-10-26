/**
 * The index of open quests the desktop reads, kept from the quests.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { orchestratorsPath } from "../../../extensions/quest-workflow/orchestrators";
import {
	keepDesktopListsCurrent,
	questIndexPath,
	questsIn,
} from "../../../extensions/quest-workflow/quest-index";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../../lib/internal/quest/discovery";
import type { LivenessSnapshot } from "../../../lib/internal/quest/session-liveness";

const MISSION = "QEST-20260101-MISSON";
const CHILD = "QEST-20260101-CHILDQ";
const OLD = "QEST-20260101-OLDONE";

let root: string;
let elsewhere: string;

const nothingKnown: LivenessSnapshot = {
	now: new Date("2026-01-02T00:00:00Z"),
	activity: new Map(),
	observations: new Map(),
	conflicted: new Set(),
};

function quest(id: string, head: string, body: string): void {
	mkdirSync(join(root, id), { recursive: true });
	writeFileSync(
		join(root, id, "README.md"),
		`---\nid: ${id}\nkind: quest\npriority: active\nrank: 1\nstarted: 2026-01-01\nupdated: 2026-01-01T03:00:00Z\n${head}\n---\n\n${body}\n`,
	);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "quest-index-"));
	elsewhere = mkdtempSync(join(tmpdir(), "quest-index-tree-"));
	clearDiscoveryCache();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(elsewhere, { recursive: true, force: true });
	clearDiscoveryCache();
});

describe("the quests the desktop lists", () => {
	it("are the open ones, parents first, with what it shows and where one starts", () => {
		quest(
			MISSION,
			"status: active\norchestrator: true\nshort: Optimus",
			"# Bootstrap optimus\n\n## 📜 Summary\n\nMake optimus the machine.\nIt is close.\n\nMore after.",
		);
		quest(
			CHILD,
			[
				"status: active",
				`parent: ${MISSION}`,
				"sessions:",
				"  - id: s-gone",
				`    cwd: ${root}/${CHILD}`,
				"    status: active",
				"  - id: s-old",
				"    status: detached",
				"trees:",
				`  - path: ${elsewhere}`,
				"    providerId: git-worktree",
			].join("\n"),
			"# A child",
		);
		mkdirSync(join(root, CHILD, "plans"));
		writeFileSync(
			join(root, CHILD, "plans", "PLAN-20260101-ABCDEF.md"),
			`---\nid: PLAN-20260101-ABCDEF\nkind: plan\nquest: ${CHILD}\nstage: build\nupdated: 2026-01-01\n---\n# The Plan\n`,
		);
		quest(OLD, "status: concluded", "# Old");

		const listed = questsIn(
			discoverQuests(root).index,
			nothingKnown,
			root,
			"/home/someone",
		);

		expect(listed).toEqual([
			{
				id: MISSION,
				address: "MISSON",
				short: "Optimus",
				title: "Bootstrap optimus",
				summary: "Make optimus the machine.\nIt is close.",
				kind: "quest",
				status: "active",
				priority: "active",
				rank: 1,
				documents: [],
				sessions: [],
				start: "/home/someone",
				updated: "2026-01-01T03:00:00Z",
			},
			{
				id: CHILD,
				address: "CHILDQ",
				title: "A child",
				kind: "quest",
				status: "active",
				priority: "active",
				rank: 1,
				parent: MISSION,
				orchestrator: "MISSON",
				documents: [
					{
						id: "PLAN-20260101-ABCDEF",
						kind: "plan",
						title: "The Plan",
						stage: "build",
					},
				],
				sessions: ["s-gone"],
				start: elsewhere,
				updated: "2026-01-01T03:00:00Z",
			},
		]);
	});

	it("are written with the orchestrators from one pass over the store", async () => {
		const state = mkdtempSync(join(tmpdir(), "quest-index-state-"));
		const before = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = state;
		try {
			quest(
				MISSION,
				"status: active\norchestrator: true",
				"# Bootstrap optimus",
			);

			await keepDesktopListsCurrent(root);

			const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
			expect(read(orchestratorsPath()).orchestrators).toEqual([
				{ quest: MISSION, address: "MISSON", title: "Bootstrap optimus" },
			]);
			expect(
				read(questIndexPath()).quests.map((one: { id: string }) => one.id),
			).toEqual([MISSION]);
		} finally {
			if (before === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = before;
			rmSync(state, { recursive: true, force: true });
		}
	});
});
