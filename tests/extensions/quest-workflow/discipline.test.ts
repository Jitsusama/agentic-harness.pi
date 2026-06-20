import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	enforceQuest,
	isFocusedDocWrite,
} from "../../../extensions/quest-workflow/enforce";
import type { QuestState } from "../../../extensions/quest-workflow/state";

// A real git repo with one tracked file and one untracked file, so
// the gate's git predicates judge real tracking state. tempRoots
// is set to [] in every call so paths under the system temp dir are
// not auto-classified as scratch (the fixtures live there).
let repo: string;
const tracked = "src/tracked.ts";
const noScratch = { tempRoots: [] as string[] };

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), "discipline-repo-"));
	const run = (args: string[]) =>
		execFileSync("git", args, { cwd: repo, stdio: "ignore" });
	run(["init", "-q"]);
	run(["config", "user.email", "t@t"]);
	run(["config", "user.name", "t"]);
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, tracked), "export const a = 1;\n");
	run(["add", tracked]);
	run(["commit", "-q", "-m", "seed"]);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

function stateFixture(overrides: Partial<QuestState> = {}): QuestState {
	return {
		questsRoot: "/tmp/quests",
		questDir: "/tmp/quests/QEST-X",
		questId: "QEST-X",
		questTitle: "Test",
		questKind: "sidequest",
		questStatus: "active",
		questPriority: "active",
		documentPath: "/tmp/quests/QEST-X/plans/PLAN-Y.md",
		documentId: "PLAN-Y",
		documentKind: "plan",
		documentTitle: "Plan",
		documentStage: "draft",
		done: 0,
		total: 0,
		...overrides,
	};
}

describe("quest discipline (plan phase)", () => {
	it("defers edits to already-tracked code while a plan is in draft", () => {
		const state = stateFixture({ documentStage: "draft" });
		const result = enforceQuest(
			state,
			"edit",
			{ path: join(repo, tracked) },
			repo,
			noScratch,
		);
		expect(result?.block).toBe(true);
	});

	it("lets new (untracked) files flow while a plan is in draft", () => {
		const state = stateFixture({ documentStage: "draft" });
		const result = enforceQuest(
			state,
			"write",
			{ path: join(repo, "src/brand-new.ts"), content: "x" },
			repo,
			noScratch,
		);
		expect(result).toBeUndefined();
	});

	it("allows writes to the focused plan document itself", () => {
		const state = stateFixture({ documentStage: "draft" });
		const path = state.documentPath ?? "";
		const result = enforceQuest(state, "write", { path, content: "..." }, "/");
		expect(result).toBeUndefined();
	});

	it("does not block when the focused doc is research, not plan", () => {
		const state = stateFixture({
			documentKind: "research",
			documentStage: "draft",
		});
		const result = enforceQuest(
			state,
			"edit",
			{ path: join(repo, tracked) },
			repo,
			noScratch,
		);
		expect(result).toBeUndefined();
	});

	it("blocks git-mutating bash commands during plan think/draft", () => {
		const state = stateFixture({ documentStage: "think" });
		const result = enforceQuest(
			state,
			"bash",
			{ command: "git commit -m foo" },
			"/tmp",
		);
		expect(result?.block).toBe(true);
	});

	it("blocks git with global options between git and the verb", () => {
		const state = stateFixture({ documentStage: "think" });
		for (const cmd of [
			"git -c user.email=x@y commit -m foo",
			"git -C /tmp/repo commit -am foo",
			"git --git-dir=/tmp/.git add .",
			"git -c gc.auto=0 push origin main",
		]) {
			const result = enforceQuest(state, "bash", { command: cmd }, "/tmp");
			expect(result?.block, `expected ${cmd} to be blocked`).toBe(true);
		}
	});

	it("blocks a bash write that targets already-tracked code in draft", () => {
		const state = stateFixture({ documentStage: "draft" });
		const result = enforceQuest(
			state,
			"bash",
			{ command: `cat >> ${join(repo, tracked)}` },
			repo,
			noScratch,
		);
		expect(result?.block).toBe(true);
	});

	it("defers an in-place edit of already-tracked code in draft", () => {
		const state = stateFixture({ documentStage: "draft" });
		for (const cmd of [
			`sed -i 's/a/b/' ${join(repo, tracked)}`,
			`perl -i -pe 's/a/b/' ${join(repo, tracked)}`,
		]) {
			const result = enforceQuest(
				state,
				"bash",
				{ command: cmd },
				repo,
				noScratch,
			);
			expect(result?.block, `expected ${cmd} to be deferred`).toBe(true);
		}
	});

	it("allows a bash redirect to a scratch path in draft", () => {
		const state = stateFixture({ documentStage: "draft" });
		const result = enforceQuest(
			state,
			"bash",
			{ command: `cat > ${join(repo, "tmp-dump.json")}` },
			repo,
			noScratch,
		);
		// tmp-dump.json is untracked and not ignored: a new file, never cornered.
		expect(result?.block).toBeFalsy();
	});

	it("does not block read-only bash, including literal mutating verbs", () => {
		const state = stateFixture({ documentStage: "draft" });
		for (const cmd of [
			"ls -la",
			"cat src/foo.ts",
			"grep needle src",
			"git status",
			'grep -n "branch -d" file.ts',
		]) {
			const result = enforceQuest(state, "bash", { command: cmd }, "/tmp");
			expect(result?.block, `${cmd} should not be blocked`).toBeFalsy();
		}
	});

	it("isFocusedDocWrite recognises edits to the focused doc", () => {
		const state = stateFixture();
		const path = state.documentPath ?? "";
		expect(isFocusedDocWrite("edit", { path }, state.documentPath, "/")).toBe(
			true,
		);
		expect(
			isFocusedDocWrite(
				"write",
				{ path: "/somewhere/else.ts" },
				state.documentPath,
				"/tmp",
			),
		).toBe(false);
	});
});
