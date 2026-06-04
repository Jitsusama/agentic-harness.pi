import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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
	it("indexes flat quests and resolves parent/child via front-matter", () => {
		writeQuest({
			id: "QEST-20260603-AAA111",
			parent: null,
			title: "Root quest",
		});
		writeQuest({
			id: "QEST-20260603-BBB222",
			parent: "QEST-20260603-AAA111",
			title: "Subquest",
		});
		const { index, errors } = discoverQuests(root);
		expect(errors).toEqual([]);
		expect(index.quests.size).toBe(2);
		expect(index.children.get("")?.length).toBe(1);
		expect(index.children.get("QEST-20260603-AAA111")?.length).toBe(1);
	});

	it("refuses a nested QEST directory as a layout error", () => {
		writeQuest({
			id: "QEST-20260603-AAA111",
			parent: null,
			title: "Root quest",
		});
		const parentDir = join(root, "QEST-20260603-AAA111");
		writeQuest({
			id: "QEST-20260603-BBB222",
			parent: "QEST-20260603-AAA111",
			title: "Nested",
			parentDir,
		});
		const { index, errors } = discoverQuests(root);
		expect(index.quests.size).toBe(1);
		expect(index.quests.has("QEST-20260603-AAA111")).toBe(true);
		expect(index.quests.has("QEST-20260603-BBB222")).toBe(false);
		expect(
			errors.some((e) =>
				e.message.includes('Nested quest "QEST-20260603-BBB222"'),
			),
		).toBe(true);
	});

	it("refuses a misplaced document at the quest-dir root", () => {
		writeQuest({
			id: "QEST-20260603-AAA111",
			parent: null,
			title: "Root quest",
		});
		const questDir = join(root, "QEST-20260603-AAA111");
		writeFileSync(
			join(questDir, "PLAN-20260603-XXXYYY.md"),
			"---\nid: PLAN-20260603-XXXYYY\nkind: plan\nquest: QEST-20260603-AAA111\nstage: draft\nupdated: 2026-06-03\n---\n\n# Misplaced plan\n",
		);
		const { index, errors } = discoverQuests(root);
		expect(index.quests.size).toBe(1);
		expect(index.quests.get("QEST-20260603-AAA111")?.documents.length).toBe(0);
		expect(
			errors.some((e) => e.message.includes("sits at the quest-dir root")),
		).toBe(true);
	});

	it("refuses an unexpected top-level directory at quests root", () => {
		mkdirSync(join(root, "stray-folder"), { recursive: true });
		writeQuest({
			id: "QEST-20260603-AAA111",
			parent: null,
			title: "Real quest",
		});
		const { index, errors } = discoverQuests(root);
		expect(index.quests.size).toBe(1);
		expect(
			errors.some((e) =>
				e.message.includes('Unexpected directory "stray-folder"'),
			),
		).toBe(true);
	});

	it("accepts documents in their canonical kind subdirectory", () => {
		writeQuest({
			id: "QEST-20260603-AAA111",
			parent: null,
			title: "Quest with docs",
		});
		const plansDir = join(root, "QEST-20260603-AAA111", "plans");
		mkdirSync(plansDir, { recursive: true });
		writeFileSync(
			join(plansDir, "PLAN-20260603-XXXYYY.md"),
			"---\nid: PLAN-20260603-XXXYYY\nkind: plan\nquest: QEST-20260603-AAA111\nstage: draft\nupdated: 2026-06-03\n---\n\n# Canonical plan\n",
		);
		const { index, errors } = discoverQuests(root);
		expect(errors).toEqual([]);
		const quest = index.quests.get("QEST-20260603-AAA111");
		expect(quest?.documents.length).toBe(1);
		expect(quest?.documents[0].doc.frontMatter.id).toBe("PLAN-20260603-XXXYYY");
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

	it("does not follow symlinks back into the tree", () => {
		writeQuest({
			id: "QEST-20260603-LLL111",
			parent: null,
			title: "Root",
		});
		// A symlink loop that would crash an unbounded walk:
		// link points back to its containing directory.
		try {
			symlinkSync(root, join(root, "loop"));
		} catch {
			// Symlinks may not be permitted in some sandboxes;
			// the test is meaningful only when we can create one.
			return;
		}
		const { index, errors } = discoverQuests(root);
		expect(index.quests.size).toBe(1);
		expect(
			errors.find((e) => e.message.includes("depth exceeded")),
		).toBeUndefined();
	});

	it("caps the nested-quest walk depth so a pathological chain cannot wedge discovery", () => {
		// Build a chain of 20 QEST dirs nested inside each
		// other so the error-reporting walk hits the depth cap.
		// Every dir gets a minimal README so they all qualify
		// as quests for the discovery walk.
		let parentDir = root;
		for (let i = 0; i < 20; i++) {
			const id = `QEST-20260603-N${String(i).padStart(5, "0")}`;
			writeQuest({
				id,
				parent:
					i === 0 ? null : `QEST-20260603-N${String(i - 1).padStart(5, "0")}`,
				title: `Nest ${i}`,
				parentDir,
			});
			parentDir = join(parentDir, id);
		}
		const { errors } = discoverQuests(root);
		expect(errors.some((e) => e.message.includes("depth exceeded"))).toBe(true);
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
