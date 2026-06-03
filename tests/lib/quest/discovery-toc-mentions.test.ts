import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverQuests } from "../../../lib/internal/quest/discovery";
import { buildMentionIndex } from "../../../lib/internal/quest/mentions";
import { scaffoldQuestReadme } from "../../../lib/internal/quest/scaffold";
import { renderToc } from "../../../lib/internal/quest/toc";
import type { QuestFrontMatter } from "../../../lib/quest/types";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index";

let root: string;

beforeEach(() => {
	clearRefTypes();
	registerBuiltinRefTypes();
	root = mkdtempSync(join(tmpdir(), "quest-tree-"));
});

afterEach(() => {
	clearRefTypes();
	rmSync(root, { recursive: true, force: true });
});

function writeQuest(opts: {
	id: string;
	parent: string | null;
	priority?: QuestFrontMatter["priority"];
	status?: QuestFrontMatter["status"];
	rank?: number;
	title: string;
	parentDir?: string;
	body?: string;
}): string {
	const parentDir = opts.parentDir ?? root;
	const dir = join(parentDir, opts.id);
	mkdirSync(dir, { recursive: true });
	const fm: QuestFrontMatter = {
		id: opts.id,
		kind: opts.parent ? "subquest" : "quest",
		parent: opts.parent,
		status: opts.status ?? "active",
		priority: opts.priority ?? "active",
		rank: opts.rank ?? 1,
		started: "2026-06-03",
		updated: "2026-06-03",
		aliases: [],
		sessions: [],
	};
	const readme = `${scaffoldQuestReadme({
		frontMatter: fm,
		title: opts.title,
	})}\n${opts.body ?? ""}`;
	writeFileSync(join(dir, "README.md"), readme);
	return dir;
}

describe("discoverQuests", () => {
	it("walks the tree and indexes every quest", () => {
		writeQuest({
			id: "QEST-20260603-AAA111",
			parent: null,
			title: "Root quest",
		});
		const subDir = join(root, "QEST-20260603-AAA111");
		writeQuest({
			id: "QEST-20260603-BBB222",
			parent: "QEST-20260603-AAA111",
			title: "Subquest",
			parentDir: subDir,
		});
		const { index, errors } = discoverQuests(root);
		expect(errors).toEqual([]);
		expect(index.quests.size).toBe(2);
		expect(index.children.get("")?.length).toBe(1);
		expect(index.children.get("QEST-20260603-AAA111")?.length).toBe(1);
	});

	it("records an error when a quest README is missing", () => {
		mkdirSync(join(root, "QEST-20260603-CCC333"), { recursive: true });
		const { index, errors } = discoverQuests(root);
		expect(index.quests.size).toBe(0);
		expect(errors.some((e) => e.message.includes("README"))).toBe(true);
	});

	it("records an error when directory name and id disagree", () => {
		const dir = join(root, "QEST-20260603-CCC333");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "README.md"),
			scaffoldQuestReadme({
				frontMatter: {
					id: "QEST-20260603-DIFFERENT",
					kind: "quest",
					parent: null,
					status: "active",
					priority: "active",
					rank: 1,
					started: "2026-06-03",
					updated: "2026-06-03",
					aliases: [],
					sessions: [],
				},
				title: "Mismatched",
			}),
		);
		const { errors } = discoverQuests(root);
		expect(errors.some((e) => e.message.includes("does not match"))).toBe(true);
	});

	it("ignores hidden and node_modules directories", () => {
		mkdirSync(join(root, "node_modules"), { recursive: true });
		mkdirSync(join(root, ".cache"), { recursive: true });
		writeQuest({
			id: "QEST-20260603-EEE555",
			parent: null,
			title: "Real quest",
		});
		const { index } = discoverQuests(root);
		expect(index.quests.size).toBe(1);
	});
});

describe("renderToc", () => {
	it("groups quests by priority and orders by rank", () => {
		writeQuest({
			id: "QEST-20260603-AAA111",
			parent: null,
			priority: "driving",
			rank: 2,
			title: "Driving second",
		});
		writeQuest({
			id: "QEST-20260603-BBB222",
			parent: null,
			priority: "driving",
			rank: 1,
			title: "Driving first",
		});
		writeQuest({
			id: "QEST-20260603-CCC333",
			parent: null,
			priority: "queued",
			rank: 1,
			title: "Queued one",
		});
		const { index } = discoverQuests(root);
		const toc = renderToc(index);
		const drivingIdx = toc.indexOf("Driving");
		const queuedIdx = toc.indexOf("Queued");
		expect(drivingIdx).toBeGreaterThan(-1);
		expect(queuedIdx).toBeGreaterThan(drivingIdx);
		const firstIdx = toc.indexOf("Driving first");
		const secondIdx = toc.indexOf("Driving second");
		expect(firstIdx).toBeGreaterThan(-1);
		expect(secondIdx).toBeGreaterThan(firstIdx);
	});

	it("collapses concluded and retired into a single trailing section", () => {
		writeQuest({
			id: "QEST-20260603-AAA111",
			parent: null,
			status: "concluded",
			title: "Done",
		});
		writeQuest({
			id: "QEST-20260603-BBB222",
			parent: null,
			status: "active",
			title: "Live",
		});
		const { index } = discoverQuests(root);
		const toc = renderToc(index);
		expect(toc).toContain("Concluded and Retired");
		expect(toc.indexOf("Concluded and Retired")).toBeGreaterThan(
			toc.indexOf("Live"),
		);
	});
});

describe("buildMentionIndex", () => {
	it("captures inbound mentions for a target quest", () => {
		writeQuest({
			id: "QEST-20260603-AAA111",
			parent: null,
			title: "Target",
		});
		writeQuest({
			id: "QEST-20260603-BBB222",
			parent: null,
			title: "Source",
			body: "See QEST-20260603-AAA111 for related work.",
		});
		const { index } = discoverQuests(root);
		const mentions = buildMentionIndex(index);
		const edges = mentions.byId.get("QEST-20260603-AAA111") ?? [];
		expect(edges).toHaveLength(1);
		expect(edges[0].from).toBe("QEST-20260603-BBB222");
		expect(edges[0].snippet).toContain("QEST-20260603-AAA111");
	});

	it("does not record self-mentions", () => {
		writeQuest({
			id: "QEST-20260603-AAA111",
			parent: null,
			title: "Self",
			body: "I mention QEST-20260603-AAA111 in my own body.",
		});
		const { index } = discoverQuests(root);
		const mentions = buildMentionIndex(index);
		expect(mentions.byId.get("QEST-20260603-AAA111") ?? []).toEqual([]);
	});

	it("captures ref mentions through the registered ref types", () => {
		writeQuest({
			id: "QEST-20260603-AAA111",
			parent: null,
			title: "Quest",
			body: "Tracks https://github.com/shop/world/pull/47281 outcome.",
		});
		const { index } = discoverQuests(root);
		const mentions = buildMentionIndex(index);
		const key = "github-pr:shop/world#47281";
		expect(mentions.byRef.get(key)).toBeDefined();
		expect(mentions.byRef.get(key)?.[0].from).toBe("QEST-20260603-AAA111");
	});
});
