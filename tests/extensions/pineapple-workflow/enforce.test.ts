import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type Judging,
	judge,
	questsOf,
} from "../../../extensions/pineapple-workflow/enforce.ts";
import { standingStops } from "../../../lib/internal/pineapple/stops.ts";

const TREE = "/trees/shop-fix";

function machine(
	stops: Record<string, unknown>[],
): Judging & { log: string; asked: string[] } {
	const root = mkdtempSync(join(tmpdir(), "pineapple-guard-"));
	const folder = join(root, "stops");
	mkdirSync(folder);
	for (const [at, record] of stops.entries()) {
		writeFileSync(join(folder, `${at}.json`), JSON.stringify(record));
	}
	const asked: string[] = [];
	const log = join(root, "would-refuse.jsonl");
	return {
		log,
		asked,
		standing: () => standingStops(folder),
		git: {
			repoOf: async () => "example/shop",
			branchOf: async (dir) => (dir === TREE ? "fix-it" : "main"),
		},
		headOf: async (repo, pr) => {
			asked.push(`${repo}#${pr}`);
			return pr === 12 ? "fix-it" : undefined;
		},
		here: () => ({ realm: "work", quests: [] }),
		trees: "/trees",
		shadowLog: log,
		records: root,
		now: () => new Date("2026-11-14T06:00:00Z"),
	};
}

const live = {
	id: "slack:C1:1.2",
	shadow: false,
	said_by: "U0OTHER001",
	where: "https://example.slack.com/archives/C1/p12",
	words: "<@U0JOEL0001> pineapple override",
	reaches: ["pr:example/shop#12"],
	resumed: null,
};

const call = (tool: string, input: unknown) => ({
	tool,
	input,
	cwd: "/work/shop",
	session: "s1",
});

describe("the write guard", () => {
	it("refuses a write a live stop reaches, saying who stopped it and who resumes", async () => {
		const verdict = await judge(
			call("work", { action: "push", tree: "shop-fix" }),
			machine([live]),
		);
		expect(verdict?.refuse).toContain("work push to fix-it of example/shop");
		expect(verdict?.refuse).toContain("U0OTHER001 said");
		expect(verdict?.refuse).toContain("pineapple override");
		expect(verdict?.refuse).toContain("Only Joel resumes");
	});

	it("lets the session's other work through", async () => {
		const judging = machine([live]);
		expect(
			await judge(call("bash", { command: "git push origin main" }), judging),
		).toBeUndefined();
		expect(
			await judge(call("bash", { command: "nix build .#x" }), judging),
		).toBeUndefined();
		expect(
			await judge(
				call("review_offer", { action: "merge", change: "example/shop#13" }),
				judging,
			),
		).toBeUndefined();
	});

	it("refuses nothing for a stop in shadow, and writes down what it would have", async () => {
		const judging = machine([{ ...live, shadow: true }]);
		const verdict = await judge(
			call("bash", {
				command: "gh pr merge https://github.com/example/shop/pull/12",
			}),
			judging,
		);
		expect(verdict).toBeUndefined();
		const [line] = readFileSync(judging.log, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(line).toMatchObject({
			session: "s1",
			action: "gh pr merge",
			repo: "example/shop",
			pr: 12,
			stops: [{ id: "slack:C1:1.2", reach: "example/shop#12" }],
		});
	});

	it("does nothing and asks nobody while no stop stands", async () => {
		const judging = machine([]);
		expect(
			await judge(call("work", { action: "push", tree: "shop-fix" }), judging),
		).toBeUndefined();
		expect(judging.asked).toEqual([]);
	});

	it("leaves a resumed stop alone", async () => {
		const judging = machine([
			{ ...live, resumed: { at: "2026-11-14T05:00:00Z" } },
		]);
		expect(
			await judge(call("work", { action: "push", tree: "shop-fix" }), judging),
		).toBeUndefined();
	});

	it("refuses changing a stop, stop or no stop, so only Joel resumes one", async () => {
		const judging = machine([]);
		const verdict = await judge(
			call("bash", { command: `rm ${judging.records}/stops/0.json` }),
			judging,
		);
		expect(verdict?.refuse).toContain("Only Joel resumes");
		expect(
			await judge(
				call("bash", { command: `cat ${judging.records}/stops/0.json` }),
				judging,
			),
		).toBeUndefined();
	});

	it("asks for a change's branch once it needs to tell a push apart", async () => {
		const judging = machine([live]);
		await judge(call("bash", { command: "gh pr merge 13" }), judging);
		expect(judging.asked).toEqual([]);
		await judge(call("bash", { command: "git push" }), judging);
		expect(judging.asked).toEqual(["example/shop#12"]);
	});
});

describe("questsOf", () => {
	it("is the session's quest and its parents, from the quest records", () => {
		const root = mkdtempSync(join(tmpdir(), "pineapple-quests-"));
		const sessions = join(root, "sessions");
		const quests = join(root, "quests");
		mkdirSync(sessions);
		mkdirSync(join(quests, "QEST-CHILD"), { recursive: true });
		mkdirSync(join(quests, "QEST-PARENT"), { recursive: true });
		writeFileSync(
			join(sessions, "s1.json"),
			JSON.stringify({ quest: "QEST-CHILD" }),
		);
		writeFileSync(
			join(quests, "QEST-CHILD", "README.md"),
			"---\nid: QEST-CHILD\nparent: QEST-PARENT\n---\n# Child\n",
		);
		writeFileSync(
			join(quests, "QEST-PARENT", "README.md"),
			"---\nid: QEST-PARENT\n---\n# Parent\n",
		);
		expect(questsOf("s1", sessions, quests)).toEqual([
			"QEST-CHILD",
			"QEST-PARENT",
		]);
		expect(questsOf("nobody", sessions, quests)).toEqual([]);
	});
});
