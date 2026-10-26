import { spawn } from "node:child_process";
import {
	chmodSync,
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
	ensureQuestWorkspaceTmp,
	processesIn,
	questWorkspace,
	removeQuestWorkspace,
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

describe("removeQuestWorkspace", () => {
	const nobody = () => [];

	it("takes the whole workspace, its caches and labs with its tmp/", () => {
		const { dir, tmp } = questWorkspace(root, QUEST_ID);
		mkdirSync(join(tmp, "deep"), { recursive: true });
		writeFileSync(join(tmp, "deep", "scratch.txt"), "x");
		mkdirSync(join(dir, "lab"));
		writeFileSync(join(dir, "lab", "results.csv"), "x");

		expect(removeQuestWorkspace(root, QUEST_ID, nobody)).toEqual({
			removed: true,
		});
		expect(existsSync(dir)).toBe(false);
	});

	it("takes a folder made read-only, as Go's module cache is", () => {
		const { dir } = questWorkspace(root, QUEST_ID);
		const module = join(dir, "cache", "go-mod", "example.com@v1.0.0");
		mkdirSync(module, { recursive: true });
		writeFileSync(join(module, "go.mod"), "module example.com\n");
		chmodSync(module, 0o555);

		expect(removeQuestWorkspace(root, QUEST_ID, nobody).removed).toBe(true);
		expect(existsSync(dir)).toBe(false);
	});

	it("leaves a workspace a process still works in", () => {
		const { dir } = questWorkspace(root, QUEST_ID);
		mkdirSync(dir, { recursive: true });

		expect(removeQuestWorkspace(root, QUEST_ID, () => [42])).toEqual({
			removed: false,
			why: "in use",
		});
		expect(existsSync(dir)).toBe(true);
	});

	it("says there was none to take", () => {
		expect(removeQuestWorkspace(root, QUEST_ID, nobody)).toEqual({
			removed: false,
			why: "none",
		});
	});
});

describe.runIf(process.platform === "linux")("processesIn", () => {
	it("finds a process working in a folder, and none once it ends", async () => {
		const { dir } = questWorkspace(root, QUEST_ID);
		mkdirSync(dir, { recursive: true });
		const child = spawn("sleep", ["30"], { cwd: dir, stdio: "ignore" });
		await new Promise((resolve) => child.once("spawn", resolve));
		try {
			expect(processesIn(dir)).toContain(child.pid);
		} finally {
			child.kill();
		}
		await new Promise((resolve) => child.once("exit", resolve));
		expect(processesIn(dir)).not.toContain(child.pid);
	});
});
