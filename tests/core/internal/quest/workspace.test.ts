import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearQuestWorkspaceTmp,
	ensureQuestWorkspaceTmp,
	questWorkspace,
} from "../../../../lib/core/internal/quest/workspace.ts";

const QUEST_ID = "QEST-20260924-ABC123";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "workspace-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("questWorkspace", () => {
	it("names the workspace after the quest, with tmp/ inside it", () => {
		expect(questWorkspace(root, QUEST_ID)).toEqual({
			dir: join(root, QUEST_ID),
			tmp: join(root, QUEST_ID, "tmp"),
		});
	});

	it("refuses anything that is not a quest's ID", () => {
		for (const id of [
			"../etc",
			"PLAN-20260924-ABC123",
			"",
			"QEST-20260924-ABC123/..",
		]) {
			expect(() => questWorkspace(root, id), id).toThrow(/not a quest ID/);
		}
	});
});

describe("ensureQuestWorkspaceTmp", () => {
	it("creates tmp/ on first need and reuses it after", () => {
		const tmp = ensureQuestWorkspaceTmp(root, QUEST_ID);
		expect(tmp).toBe(join(root, QUEST_ID, "tmp"));
		expect(existsSync(tmp)).toBe(true);
		writeFileSync(join(tmp, "kept.txt"), "x");
		expect(ensureQuestWorkspaceTmp(root, QUEST_ID)).toBe(tmp);
		expect(readdirSync(tmp)).toEqual(["kept.txt"]);
	});
});

describe("clearQuestWorkspaceTmp", () => {
	it("empties tmp/ and leaves the rest of the workspace", () => {
		const { dir, tmp } = questWorkspace(root, QUEST_ID);
		mkdirSync(join(tmp, "deep"), { recursive: true });
		writeFileSync(join(tmp, "deep", "scratch.txt"), "x");
		mkdirSync(join(dir, "lab"));
		writeFileSync(join(dir, "lab", "results.csv"), "x");

		expect(clearQuestWorkspaceTmp(root, QUEST_ID)).toBe(true);
		expect(existsSync(tmp)).toBe(false);
		expect(existsSync(join(dir, "lab", "results.csv"))).toBe(true);
	});

	it("reports that there was nothing to clear", () => {
		expect(clearQuestWorkspaceTmp(root, QUEST_ID)).toBe(false);
	});
});
