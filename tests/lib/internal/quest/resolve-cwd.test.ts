import { describe, expect, it } from "vitest";
import type {
	QuestEntry,
	QuestIndex,
} from "../../../../lib/internal/quest/discovery";
import { questIdForCwd } from "../../../../lib/internal/quest/resolve-cwd";
import type { QuestFrontMatter, QuestTree } from "../../../../lib/quest/types";

function entry(
	id: string,
	dir: string,
	opts: { status?: QuestFrontMatter["status"]; trees?: QuestTree[] } = {},
): QuestEntry {
	return {
		dir,
		documents: [],
		doc: {
			title: id,
			body: "",
			frontMatter: {
				id,
				kind: "quest",
				parent: null,
				status: opts.status ?? "active",
				priority: "active",
				rank: 1,
				started: "2026-01-01",
				updated: "2026-01-01",
				aliases: [],
				sessions: [],
				...(opts.trees ? { trees: opts.trees } : {}),
			},
		},
	} as unknown as QuestEntry;
}

function index(...entries: QuestEntry[]): QuestIndex {
	return {
		quests: new Map(entries.map((e) => [e.doc.frontMatter.id, e])),
		children: new Map(),
	};
}

const scaffolded = (path: string): QuestTree =>
	({ path, origin: "scaffolded" }) as QuestTree;

describe("resolving a working directory to the quest that owns it", () => {
	it("finds the quest whose own directory covers the cwd", () => {
		const idx = index(entry("QEST-A", "/quests/QEST-A"));

		expect(questIdForCwd(idx, "/quests/QEST-A/plans")).toBe("QEST-A");
	});

	it("answers nothing when no quest covers the cwd", () => {
		const idx = index(entry("QEST-A", "/quests/QEST-A"));

		expect(questIdForCwd(idx, "/somewhere/else")).toBeUndefined();
	});

	it("prefers a live quest over a sealed one covering the same cwd", () => {
		const idx = index(
			entry("QEST-DEAD", "/shared", { status: "concluded" }),
			entry("QEST-LIVE", "/shared"),
		);

		expect(questIdForCwd(idx, "/shared/work")).toBe("QEST-LIVE");
	});

	it("prefers the live quest whichever order they are discovered in", () => {
		// The tie-break must not depend on Map insertion order, which is
		// discovery order, which is the filesystem's business.
		const idx = index(
			entry("QEST-LIVE", "/shared"),
			entry("QEST-DEAD", "/shared", { status: "concluded" }),
		);

		expect(questIdForCwd(idx, "/shared/work")).toBe("QEST-LIVE");
	});

	it("falls back to a scaffolded tree when no quest directory matches", () => {
		const idx = index(
			entry("QEST-A", "/quests/QEST-A", {
				trees: [scaffolded("/work/tree-a")],
			}),
		);

		expect(questIdForCwd(idx, "/work/tree-a/src")).toBe("QEST-A");
	});

	it("prefers the deepest tree so a nested tree resolves to its owner", () => {
		const idx = index(
			entry("QEST-OUTER", "/quests/O", { trees: [scaffolded("/work/outer")] }),
			entry("QEST-INNER", "/quests/I", {
				trees: [scaffolded("/work/outer/inner")],
			}),
		);

		expect(questIdForCwd(idx, "/work/outer/inner/src")).toBe("QEST-INNER");
	});

	it("ignores an adopted tree, which may be a shared checkout", () => {
		// Only a scaffolded tree magnetizes: an adopted one is a reference
		// to a checkout several quests may name, so resolving through it
		// would pick an arbitrary owner.
		const idx = index(
			entry("QEST-A", "/quests/QEST-A", {
				trees: [{ path: "/work/shared", origin: "adopted" } as QuestTree],
			}),
		);

		expect(questIdForCwd(idx, "/work/shared/src")).toBeUndefined();
	});

	it("does not treat a sibling with a shared prefix as covering", () => {
		// "/work/tree-a2" starts with "/work/tree-a" as a string but is a
		// different directory. This is the boundary the two hand-written
		// copies of isUnder disagreed about.
		const idx = index(
			entry("QEST-A", "/quests/QEST-A", {
				trees: [scaffolded("/work/tree-a")],
			}),
		);

		expect(questIdForCwd(idx, "/work/tree-a2/src")).toBeUndefined();
	});

	it("treats the tree root itself as inside the tree", () => {
		const idx = index(
			entry("QEST-A", "/quests/QEST-A", {
				trees: [scaffolded("/work/tree-a")],
			}),
		);

		expect(questIdForCwd(idx, "/work/tree-a")).toBe("QEST-A");
	});

	it("lets a quest directory win over a deeper scaffolded tree", () => {
		// A quest's own folder is the strongest claim, whatever the path
		// lengths say.
		const idx = index(
			entry("QEST-DIR", "/quests/QEST-DIR"),
			entry("QEST-TREE", "/quests/QEST-TREE", {
				trees: [scaffolded("/quests/QEST-DIR/deep/tree")],
			}),
		);

		expect(questIdForCwd(idx, "/quests/QEST-DIR/deep/tree/src")).toBe(
			"QEST-DIR",
		);
	});
});
