/**
 * What a quest has on this machine for `pi-carry`: read from the quest
 * workflow's session records, the quest's README, the work broker's
 * records and pi's session store.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTreeMemory } from "../../../../lib/core/work/memory.ts";
import {
	questHere,
	type Stores,
} from "../../../../lib/internal/carry/quest-here.ts";
import { serializeQuestFrontMatter } from "../../../../lib/internal/quest/documents/frontmatter.ts";
import type { SessionRecord } from "../../../../lib/internal/quest/sessions/session-registry.ts";

const QUEST = "QEST-20261107-CARRY1";

/** Empty stores in a folder of their own. */
function stores(): Stores & { root: string } {
	const root = mkdtempSync(join(tmpdir(), "quest-here-"));
	const at = (name: string) => {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		return dir;
	};
	return {
		root,
		registry: at("registry"),
		quests: at("quests"),
		treeRecords: at("cut"),
		sessionStore: at("sessions"),
	};
}

/** A session record as the quest workflow writes one. */
function record(
	at: Stores,
	sessionId: string,
	over: Partial<SessionRecord> = {},
): void {
	const written: SessionRecord = {
		sessionId,
		instanceId: `i-${sessionId}`,
		cwd: `/home/joel/src/${sessionId}`,
		quest: QUEST,
		openedAt: "2026-11-07T20:00:00.000Z",
		...over,
	};
	writeFileSync(
		join(at.registry, `${sessionId}.json`),
		JSON.stringify(written),
	);
}

describe("what a quest has on this machine", () => {
	it("names the sessions nobody closed that no pi runs or holds parked", () => {
		const at = stores();
		record(at, "s-rest");
		record(at, "s-runs");
		record(at, "s-parked");
		record(at, "s-quit", {
			closedAt: "2026-11-07T21:00:00.000Z",
			endReason: "quit",
		});
		record(at, "s-lost", {
			closedAt: "2026-11-07T21:00:00.000Z",
			endReason: "died",
		});
		record(at, "s-elsewhere", { quest: "QEST-20261107-OTHER1" });
		const folder = join(at.sessionStore, "--home-joel-src-s-rest--");
		mkdirSync(folder);
		writeFileSync(
			join(folder, "2026-11-07T20-00-00-000Z_s-rest.jsonl"),
			"{}\n",
		);
		mkdirSync(join(at.quests, QUEST));
		writeFileSync(
			join(at.quests, QUEST, "README.md"),
			`${serializeQuestFrontMatter({
				id: QUEST,
				kind: "quest",
				parent: null,
				status: "active",
				priority: "active",
				rank: 1,
				started: "2026-11-07",
				updated: "2026-11-07",
				aliases: [],
				sessions: [{ id: "s-rest", name: "Resting" }],
			})}\n# Carry\n`,
		);

		const here = questHere(QUEST, at, {
			runs: (one) => one.sessionId === "s-runs",
			parked: (session) => session === "s-parked",
		});

		expect(here.resting).toEqual([
			{
				id: "s-lost",
				cwd: "/home/joel/src/s-lost",
			},
			{
				id: "s-rest",
				cwd: "/home/joel/src/s-rest",
				title: "Resting",
				file: join(folder, "2026-11-07T20-00-00-000Z_s-rest.jsonl"),
			},
		]);
	});

	// OSPHT4 [2e4aacbc], KP0L6A [9301591f], 15 November: a session pi
	// rolled over into died before its pi ran a turn, its log only its
	// parent's history, and carrying it would start that old copy there
	// while its parent's line of sessions went on.
	it("leaves out a session whose log holds nothing after its start", () => {
		const at = stores();
		const lost = {
			closedAt: "2026-11-13T19:24:49.341Z",
			endReason: "died" as const,
		};
		record(at, "s-never-ran", lost);
		record(at, "s-ran", lost);
		const folder = join(at.sessionStore, "--home-joel--");
		mkdirSync(folder);
		const log = (id: string, entries: readonly object[]) => {
			const file = join(folder, `2026-11-13T19-24-49-262Z_${id}.jsonl`);
			const header = {
				type: "session",
				id,
				timestamp: "2026-11-13T19:24:49.262Z",
				parentSession: "/sessions/parent.jsonl",
			};
			writeFileSync(
				file,
				`${[header, ...entries].map((one) => JSON.stringify(one)).join("\n")}\n`,
			);
			return file;
		};
		const copied = [
			{ type: "message", timestamp: "2026-11-13T19:23:08.603Z" },
			{
				type: "custom",
				customType: "session-rollover",
				timestamp: "2026-11-13T19:24:49.262Z",
			},
		];
		log("s-never-ran", copied);
		const ran = log("s-ran", [
			...copied,
			{ type: "message", timestamp: "2026-11-13T19:30:00.000Z" },
		]);

		const here = questHere(QUEST, at, {
			runs: () => false,
			parked: () => false,
		});

		expect(here.resting, "a session that never ran was carried").toEqual([
			{ id: "s-ran", cwd: "/home/joel/src/s-ran", file: ran },
		]);
		expect(
			here.sessions.has("s-never-ran"),
			"its trees stopped being the quest's",
		).toBe(true);
	});

	// On 15 November this quest's own 01a1c91d, signalled on 13 November,
	// would have been carried, though 01a1ccc9 continued it and that
	// line of sessions still runs.
	it("leaves out a session a later one continued", () => {
		const at = stores();
		const lost = {
			closedAt: "2026-11-13T22:40:01.238Z",
			endReason: "signalled" as const,
		};
		record(at, "s-continued", lost);
		record(at, "s-left", lost);
		const folder = join(at.sessionStore, "--home-joel--");
		mkdirSync(folder);
		const log = (id: string, parent?: string) => {
			const file = join(folder, `2026-11-13T10-00-00-000Z_${id}.jsonl`);
			const header = {
				type: "session",
				id,
				timestamp: "2026-11-13T10:00:00.000Z",
				...(parent ? { parentSession: parent } : {}),
			};
			const turn = { type: "message", timestamp: "2026-11-13T11:00:00.000Z" };
			writeFileSync(
				file,
				`${JSON.stringify(header)}\n${JSON.stringify(turn)}\n`,
			);
			return file;
		};
		const continued = log("s-continued");
		const left = log("s-left");
		// The one that went on, under another quest's record or none.
		log("s-next", continued);

		const here = questHere(QUEST, at, {
			runs: () => false,
			parked: () => false,
		});

		expect(here.resting, "a continued session was carried").toEqual([
			{ id: "s-left", cwd: "/home/joel/src/s-left", file: left },
		]);
	});

	it("names every session it has had, its trees here and the broker's", () => {
		const at = stores();
		record(at, "s-now");
		record(at, "s-moved-on", {
			quest: "QEST-20261107-OTHER1",
			previousQuests: { [QUEST]: "2026-11-07T20:30:00.000Z" },
		});
		const here = join(at.root, "trees", "here");
		const held = join(at.root, "trees", "held");
		mkdirSync(here, { recursive: true });
		mkdirSync(held, { recursive: true });
		createTreeMemory(at.treeRecords).remember({
			identity: { key: "held", shareable: false },
			path: held,
			providerId: "git",
			sessions: ["s-moved-on"],
		});
		mkdirSync(join(at.quests, QUEST));
		writeFileSync(
			join(at.quests, QUEST, "README.md"),
			`${serializeQuestFrontMatter({
				id: QUEST,
				kind: "quest",
				parent: null,
				status: "active",
				priority: "active",
				rank: 1,
				started: "2026-11-07",
				updated: "2026-11-07",
				aliases: [],
				sessions: [{ id: "s-readme" }],
				trees: [
					{ path: here, providerId: "git", host: hostname() },
					// A host that can't be this one: named penelope, it was this
					// machine when the check ran there (Y9XISP, 8 November).
					{
						path: "/elsewhere/tree",
						providerId: "git",
						host: `${hostname()}-elsewhere`,
					},
				],
			})}\n# Carry\n`,
		);

		const found = questHere(QUEST, at, {
			runs: () => false,
			parked: () => false,
		});

		expect([...found.sessions].sort()).toEqual([
			"s-moved-on",
			"s-now",
			"s-readme",
		]);
		expect(found.trees).toEqual([here]);
		expect(found.held).toEqual([{ path: held, sessions: ["s-moved-on"] }]);
	});

	it("names a World tree by the src its checkout stands in", () => {
		const at = stores();
		// A World dev-tree stands as trees/<name>/src, its git in src, while
		// the quest's README names trees/<name>, as tree-add writes it
		// (0FX11G's and MZ5YL7's carries, 27 November).
		const world = join(at.root, "world", "trees", "dev");
		mkdirSync(join(world, "src", ".git"), { recursive: true });
		const own = join(at.root, "trees", "own");
		mkdirSync(join(own, ".git"), { recursive: true });
		mkdirSync(join(own, "src", ".git"), { recursive: true });
		mkdirSync(join(at.quests, QUEST));
		writeFileSync(
			join(at.quests, QUEST, "README.md"),
			`${serializeQuestFrontMatter({
				id: QUEST,
				kind: "quest",
				parent: null,
				status: "active",
				priority: "active",
				rank: 1,
				started: "2026-11-27",
				updated: "2026-11-27",
				aliases: [],
				sessions: [],
				trees: [
					{ path: world, providerId: "dev-tree", host: hostname() },
					{ path: own, providerId: "git", host: hostname() },
				],
			})}\n# Carry\n`,
		);

		const found = questHere(QUEST, at, {
			runs: () => false,
			parked: () => false,
		});

		expect(
			found.trees,
			"a tree with a git of its own is named as it is",
		).toEqual([join(world, "src"), own]);
	});
});
