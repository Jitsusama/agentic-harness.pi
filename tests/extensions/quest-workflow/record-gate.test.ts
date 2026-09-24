import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enforceQuest } from "../../../extensions/quest-workflow/enforce";
import {
	createQuestState,
	type QuestState,
} from "../../../extensions/quest-workflow/state";

const QUEST = "QEST-20260924-ABC123";
const OTHER = "QEST-20260101-OTHER1";
let root: string;
let questsRoot: string;
let workspaceRoot: string;
let questDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "record-gate-"));
	questsRoot = join(root, "quests");
	workspaceRoot = join(root, "workspaces");
	questDir = join(questsRoot, QUEST);
	mkdirSync(join(questDir, "plans"), { recursive: true });
	writeFileSync(join(questDir, "README.md"), "# Quest\n");
	writeFileSync(join(questDir, "plans", "PLAN-20260924-RUE4Q4.md"), "# Plan\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A state with nothing loaded, which is when the old gate slept. */
function idle(): QuestState {
	return createQuestState({ questsRoot });
}

function check(
	toolName: string,
	input: Record<string, unknown>,
	state: QuestState = idle(),
	cwd = questDir,
) {
	return enforceQuest(state, toolName, input, cwd, {
		tempRoots: [],
		workspaceRoot,
		home: root,
	});
}

describe("the record gate", () => {
	it("sends a stray to the workspace with nothing loaded", () => {
		const verdict = check("write", { path: join(questDir, "lab/results.csv") });
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason).toContain(
			join(workspaceRoot, QUEST, "lab/results.csv"),
		);
	});

	it("follows a cd into the quest folder", () => {
		const verdict = check(
			"bash",
			{ command: `cd ${questDir} && git clone https://x.test/r.git` },
			idle(),
			root,
		);
		expect(verdict?.reason).toContain(join(workspaceRoot, QUEST, "r"));
	});

	it("keeps bash out of a document", () => {
		const verdict = check("bash", {
			command: "printf 'x\\n' >> plans/PLAN-20260924-RUE4Q4.md",
		});
		expect(verdict?.reason).toContain("edit or write tool");
	});

	it("refuses removing the README", () => {
		expect(check("bash", { command: "rm README.md" })?.reason).toContain(
			"`quest retire`",
		);
	});

	it("refuses a hand-made document", () => {
		expect(
			check("write", { path: join(questDir, "plans/PLAN-20260924-NEW001.md") })
				?.reason,
		).toContain("`quest draft`");
	});

	it("judges another quest's folder while this one is loaded", () => {
		const state = idle();
		state.questDir = questDir;
		state.questId = QUEST;
		const verdict = check(
			"write",
			{ path: join(questsRoot, OTHER, "notes.txt") },
			state,
		);
		expect(verdict?.reason).toContain(join(workspaceRoot, OTHER, "notes.txt"));
	});

	it("lets the record's own writes through", () => {
		expect(
			check("edit", { path: join(questDir, "plans/PLAN-20260924-RUE4Q4.md") }),
		).toBeUndefined();
		expect(
			check("bash", {
				command: "mkdir -p attachments && cp /x/a.png attachments/",
			}),
		).toBeUndefined();
		expect(check("bash", { command: "rm -rf lab" })).toBeUndefined();
	});

	it("says it is the quest workflow speaking", () => {
		expect(check("write", { path: join(questDir, "x.txt") })?.reason).toMatch(
			/^Quest workflow: /,
		);
	});
});
