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
import { serializeQuestFrontMatter } from "../../../../lib/internal/quest/frontmatter.ts";
import type { SessionRecord } from "../../../../lib/internal/quest/session-registry.ts";

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
});
