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
import { findOrCreateSidequestForPr } from "../../../lib/internal/quest/pr-sidequest";
import {
	getQuestPrBridge,
	parseQuestFrontMatter,
	registerQuestPrBridge,
	unregisterQuestPrBridge,
} from "../../../lib/quest";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pr-sidequest-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	unregisterQuestPrBridge();
});

function fixedNow(): () => Date {
	return () => new Date("2026-06-03T12:00:00Z");
}

function writeFakeQuest(opts: {
	dir: string;
	id: string;
	aliases?: { type: string; value: string }[];
	parent?: string | null;
}): void {
	mkdirSync(opts.dir, { recursive: true });
	const aliases = (opts.aliases ?? [])
		.map((a) => `  - type: ${a.type}\n    value: ${a.value}`)
		.join("\n");
	const parentLine =
		opts.parent === undefined || opts.parent === null
			? "parent: null"
			: `parent: ${opts.parent}`;
	const fm = `---\nid: ${opts.id}\nkind: sidequest\n${parentLine}\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-06-01\nupdated: 2026-06-01\naliases:\n${aliases || "  []"}\nsessions: []\n---`;
	writeFileSync(
		join(opts.dir, "README.md"),
		`${fm}\n\n# Fake Quest\n\n## 📜 Summary\n\nFake.\n\n## 🌄 Journey\n\n- **2026-06-01**: Created.\n`,
	);
}

describe("findOrCreateSidequestForPr", () => {
	it("scaffolds a fresh sidequest when no alias matches", () => {
		const result = findOrCreateSidequestForPr(
			{ owner: "Shopify", repo: "world", number: 123 },
			{
				questsRoot: root,
				parentQuestId: "QEST-20260601-PAR111",
				title: "Refactor the foo",
				authorHandle: "joel.gerber",
				url: "https://github.com/Shopify/world/pull/123",
				now: fixedNow(),
			},
		);
		expect(result.isNew).toBe(true);
		expect(result.sidequestId).toMatch(/^QEST-\d{8}-[A-Z0-9]{6}$/);
		expect(result.parentQuestId).toBe("QEST-20260601-PAR111");
		const readme = readFileSync(join(result.sidequestDir, "README.md"), "utf8");
		const parsed = parseQuestFrontMatter(readme);
		expect(parsed?.frontMatter.aliases).toEqual([
			{ type: "github-pr", value: "Shopify/world#123" },
		]);
		expect(parsed?.frontMatter.parent).toBe("QEST-20260601-PAR111");
		expect(readme).toContain("# Refactor the foo");
		expect(readme).toContain("Loaded for review from");
		expect(readme).toContain("@joel.gerber");
	});

	it("reuses an existing sidequest when its alias matches", () => {
		writeFakeQuest({
			dir: join(root, "QEST-20260601-EXIST1"),
			id: "QEST-20260601-EXIST1",
			aliases: [{ type: "github-pr", value: "Shopify/world#123" }],
		});
		const result = findOrCreateSidequestForPr(
			{ owner: "Shopify", repo: "world", number: 123 },
			{
				questsRoot: root,
				parentQuestId: "QEST-20260601-PAR111",
				title: "Should be ignored",
				now: fixedNow(),
			},
		);
		expect(result.isNew).toBe(false);
		expect(result.sidequestId).toBe("QEST-20260601-EXIST1");
		const readme = readFileSync(join(result.sidequestDir, "README.md"), "utf8");
		expect(readme).toContain("# Fake Quest");
		expect(readme).not.toContain("# Should be ignored");
	});

	it("creates a free-standing sidequest when no parent is supplied", () => {
		const result = findOrCreateSidequestForPr(
			{ owner: "Shopify", repo: "world", number: 7 },
			{ questsRoot: root, title: "Standalone", now: fixedNow() },
		);
		expect(result.parentQuestId).toBe(null);
		const readme = readFileSync(join(result.sidequestDir, "README.md"), "utf8");
		const parsed = parseQuestFrontMatter(readme);
		expect(parsed?.frontMatter.parent).toBe(null);
	});

	it("does not collide alias values across owner/repo pairs", () => {
		writeFakeQuest({
			dir: join(root, "QEST-20260601-OTHER1"),
			id: "QEST-20260601-OTHER1",
			aliases: [{ type: "github-pr", value: "Shopify/other#123" }],
		});
		const result = findOrCreateSidequestForPr(
			{ owner: "Shopify", repo: "world", number: 123 },
			{ questsRoot: root, title: "World", now: fixedNow() },
		);
		expect(result.isNew).toBe(true);
		expect(result.sidequestId).not.toBe("QEST-20260601-OTHER1");
	});
});

describe("quest PR bridge", () => {
	it("starts unregistered", () => {
		expect(getQuestPrBridge()).toBeUndefined();
	});

	it("register / unregister round-trips", () => {
		registerQuestPrBridge({
			questsRoot: () => root,
			loadedQuestId: () => "QEST-20260601-AAAAAA",
			logJourney: () => {},
		});
		expect(getQuestPrBridge()?.questsRoot()).toBe(root);
		expect(getQuestPrBridge()?.loadedQuestId()).toBe("QEST-20260601-AAAAAA");
		unregisterQuestPrBridge();
		expect(getQuestPrBridge()).toBeUndefined();
	});

	it("the latest registration wins", () => {
		registerQuestPrBridge({
			questsRoot: () => "/a",
			loadedQuestId: () => null,
			logJourney: () => {},
		});
		registerQuestPrBridge({
			questsRoot: () => "/b",
			loadedQuestId: () => null,
			logJourney: () => {},
		});
		expect(getQuestPrBridge()?.questsRoot()).toBe("/b");
	});
});
