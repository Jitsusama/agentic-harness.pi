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
import { orchestratorsPath } from "../../../extensions/quest-workflow/orchestrators.ts";
import {
	endedQuestsIn,
	endedQuestsPath,
	keepDesktopListsCurrent,
	questIndexPath,
	questsIn,
} from "../../../extensions/quest-workflow/quest-index.ts";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../../lib/internal/quest/discovery.ts";
import type { LivenessSnapshot } from "../../../lib/internal/quest/session-liveness.ts";

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

/** A quest's README; a quest unless its head says another kind. */
function quest(id: string, head: string, body: string): void {
	mkdirSync(join(root, id), { recursive: true });
	const kind = /^kind: /m.test(head) ? "" : "kind: quest\n";
	writeFileSync(
		join(root, id, "README.md"),
		`---\nid: ${id}\n${kind}priority: active\nrank: 1\nstarted: 2026-01-01\nupdated: 2026-01-01T03:00:00Z\n${head}\n---\n\n${body}\n`,
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
				"kind: subquest",
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
				"quest.kind": "quest",
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
				kind: "subquest",
				"quest.kind": "subquest",
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
				sessions: [],
				start: elsewhere,
				updated: "2026-01-01T03:00:00Z",
			},
		]);
	});

	describe("a closed quest's session to reopen", () => {
		const lastWeek = "2026-01-01T00:00:00Z";
		const lastNight = "2026-01-01T23:00:00Z";
		// A session's process from the boot before, as a power-off leaves it.
		const ended = (id: string, cwd: string, status: string) =>
			[
				`  - id: ${id}`,
				`    cwd: ${cwd}`,
				`    status: ${status}`,
				"    process:",
				"      hostId: optimus",
				"      pid: 4816",
				"      startToken: Mon Dec 29 09:00:00 2025",
			].join("\n");
		const seen = (activity: Record<string, string>): LivenessSnapshot => ({
			...nothingKnown,
			activity: new Map(Object.entries(activity)),
			observations: new Map(
				Object.keys(activity).map((id) => [id, { process: "gone" }]),
			),
		});
		const listedFor = (
			sessions: string[],
			snapshot: LivenessSnapshot,
			lastQuestOf?: (sessionId: string) => string | undefined,
			presentAt?: (sessionId: string) => string | undefined,
		) => {
			quest(
				MISSION,
				["status: active", "orchestrator: true", "sessions:", ...sessions].join(
					"\n",
				),
				"# Bootstrap optimus",
			);
			return questsIn(
				discoverQuests(root).index,
				snapshot,
				root,
				"/home/someone",
				lastQuestOf,
				presentAt,
			)[0];
		};

		it("is its newest one, in its own folder, not a stale one still marked active", () => {
			const gone = join(elsewhere, "a-tree-since-released");
			const work = join(elsewhere, "src", "karst");
			mkdirSync(work, { recursive: true });

			const listed = listedFor(
				[
					ended("s-month-old", gone, "active"),
					ended("s-last-night", work, "detached"),
				],
				seen({ "s-month-old": lastWeek, "s-last-night": lastNight }),
			);

			expect(listed?.sessions).toEqual([]);
			expect(listed?.resume).toEqual({
				id: "s-last-night",
				cwd: work,
				at: "2026-01-01T23:00:00.000Z",
			});
		});

		it("was last live when its presence last said so, past its log's newest entry", () => {
			const work = join(elsewhere, "src", "karst");
			mkdirSync(work, { recursive: true });
			// An idle session's log stands still while its presence is kept.
			const closedThisMorning = "2026-01-02T07:30:00.000Z";

			const listed = listedFor(
				[ended("s-idle-all-night", work, "detached")],
				seen({ "s-idle-all-night": lastNight }),
				undefined,
				(session) =>
					session === "s-idle-all-night" ? closedThisMorning : undefined,
			);

			expect(listed?.resume?.at).toBe(closedThisMorning);
		});

		// 10 November: with only this moving, the list of 194 quests was
		// written every 7 to 10 s, each costing the shell 618 ms (PT5P13).
		// The launcher orders only closed quests by it.
		it("is said to the hour while its session runs, so the list stands still", () => {
			const work = join(elsewhere, "src", "karst");
			mkdirSync(work, { recursive: true });
			const running = (logged: string): LivenessSnapshot => ({
				...nothingKnown,
				activity: new Map([["s-running", logged]]),
				observations: new Map([["s-running", { process: "matching" }]]),
			});
			const listedAt = (logged: string, present: string) =>
				listedFor(
					[ended("s-running", work, "active")],
					running(logged),
					undefined,
					() => present,
				);

			const first = listedAt(
				"2026-01-02T07:41:56.676Z",
				"2026-01-02T07:42:11.879Z",
			);
			const later = listedAt(
				"2026-01-02T07:58:02.240Z",
				"2026-01-02T07:59:13.206Z",
			);

			expect(first?.sessions).toEqual(["s-running"]);
			expect(first?.resume?.at).toBe("2026-01-02T07:00:00.000Z");
			expect(later).toEqual(first);
		});

		it("is none when its newest one's folder is gone, rather than an older one", () => {
			const gone = join(elsewhere, "a-tree-since-released");
			const older = join(elsewhere, "src", "karst");
			mkdirSync(older, { recursive: true });

			const listed = listedFor(
				[
					ended("s-older", older, "detached"),
					ended("s-newest", gone, "detached"),
				],
				seen({ "s-older": lastWeek, "s-newest": lastNight }),
			);

			expect(listed).not.toHaveProperty("resume");
		});

		it("passes over a session that moved on to another quest, however recent", () => {
			// It is still in this quest's README, and newest because it runs
			// elsewhere now: reopening it here would be a second pi on it.
			const mine = join(elsewhere, "src", "karst");
			const theirs = join(elsewhere, "src", "theirs");
			mkdirSync(mine, { recursive: true });
			mkdirSync(theirs, { recursive: true });

			const listed = listedFor(
				[
					ended("s-mine", mine, "detached"),
					ended("s-moved-on", theirs, "detached"),
				],
				seen({ "s-mine": lastWeek, "s-moved-on": lastNight }),
				(session) =>
					session === "s-moved-on" ? "QEST-20260101-ANOTHR" : MISSION,
			);

			expect(listed?.resume).toMatchObject({ id: "s-mine", cwd: mine });
		});

		it("is none for a session pi never saved", () => {
			const work = join(elsewhere, "src", "karst");
			mkdirSync(work, { recursive: true });

			const listed = listedFor(
				[ended("s-unsaved", work, "detached")],
				nothingKnown,
			);

			expect(listed).not.toHaveProperty("resume");
		});
	});

	it("carry the name a quest's team goes by in the swarm, from its swarm alias", () => {
		quest(
			MISSION,
			[
				"status: active",
				"aliases:",
				"  - type: github-pr",
				"    value: someone/reef#7",
				"  - type: swarm",
				"    value: reef",
			].join("\n"),
			"# Quick Wins That Move the Reef",
		);
		quest(CHILD, "status: active", "# A child");

		const listed = questsIn(discoverQuests(root).index, nothingKnown, root);
		const named = listed.find((entry) => entry.id === MISSION);
		const unnamed = listed.find((entry) => entry.id === CHILD);

		expect(named?.swarm).toBe("reef");
		expect(unnamed).toBeDefined();
		expect(unnamed).not.toHaveProperty("swarm");
	});

	it("leave the ended ones to their own list, by id, each starting in its newest session's folder", () => {
		const newer = mkdtempSync(join(tmpdir(), "quest-index-newer-"));
		try {
			quest(MISSION, "status: active", "# Bootstrap optimus");
			quest(
				OLD,
				[
					"status: concluded",
					"short: Old",
					`parent: ${MISSION}`,
					"sessions:",
					"  - id: s-first",
					`    cwd: ${elsewhere}`,
					"    started: 2026-01-01T01:00:00Z",
					"    status: detached",
					"  - id: s-last",
					`    cwd: ${newer}`,
					"    started: 2026-01-01T02:00:00Z",
					"    status: detached",
				].join("\n"),
				"# Old\n\n## 📜 Summary\n\nIt was done.",
			);
			quest(CHILD, "kind: sidequest\nstatus: retired", "# A child");
			const { index } = discoverQuests(root);

			expect(endedQuestsIn(index, root, "/home/someone")).toEqual([
				{
					id: CHILD,
					address: "CHILDQ",
					title: "A child",
					kind: "sidequest",
					"quest.kind": "sidequest",
					status: "retired",
					start: "/home/someone",
					updated: "2026-01-01T03:00:00Z",
				},
				{
					id: OLD,
					address: "OLDONE",
					short: "Old",
					title: "Old",
					summary: "It was done.",
					kind: "quest",
					"quest.kind": "quest",
					status: "concluded",
					parent: MISSION,
					start: newer,
					updated: "2026-01-01T03:00:00Z",
				},
			]);
			expect(questsIn(index, nothingKnown, root).map((one) => one.id)).toEqual([
				MISSION,
			]);
		} finally {
			rmSync(newer, { recursive: true, force: true });
		}
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
			quest(OLD, "status: concluded", "# Old");

			await keepDesktopListsCurrent(root);

			const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
			expect(read(orchestratorsPath()).orchestrators).toEqual([
				{ quest: MISSION, address: "MISSON", title: "Bootstrap optimus" },
			]);
			expect(
				read(questIndexPath()).quests.map((one: { id: string }) => one.id),
			).toEqual([MISSION]);
			expect(
				read(endedQuestsPath()).quests.map((one: { id: string }) => one.id),
			).toEqual([OLD]);
		} finally {
			if (before === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = before;
			rmSync(state, { recursive: true, force: true });
		}
	});
});
