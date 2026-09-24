import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	questsTouchedBy,
	RecordWatch,
} from "../../../extensions/quest-workflow/record-watch";
import { createQuestState } from "../../../extensions/quest-workflow/state";

const QUEST = "QEST-20260924-ABC123";
const OTHER = "QEST-20260101-OTHER1";
let root: string;
let questsRoot: string;
let workspaceRoot: string;
let watch: RecordWatch;

function put(quest: string, rel: string, content = "x\n"): void {
	const path = join(questsRoot, quest, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function remove(quest: string, rel: string): void {
	rmSync(join(questsRoot, quest, rel), { recursive: true, force: true });
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "record-watch-"));
	questsRoot = join(root, "quests");
	workspaceRoot = join(root, "workspaces");
	for (const quest of [QUEST, OTHER]) put(quest, "README.md", "# Quest\n");
	watch = new RecordWatch({ questsRoot, workspaceRoot });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("RecordWatch.after", () => {
	it("says nothing about breakage that was there before the call", () => {
		put(QUEST, "lab/old.csv");
		watch.before("call-1", [QUEST]);
		expect(watch.after("call-1")).toBeUndefined();
	});

	it("reports what a call broke once, naming where it belongs", () => {
		watch.before("call-1", [QUEST]);
		put(QUEST, "lab/results.csv");
		const report = watch.after("call-1") ?? "";
		expect(report).toMatch(/^Quest workflow: /);
		expect(report).toContain(`${QUEST}`);
		expect(report).toContain("lab");
		expect(report).toContain(join(workspaceRoot, QUEST, "lab"));

		watch.before("call-2", [QUEST]);
		expect(watch.after("call-2")).toBeUndefined();
	});

	it("reports breakage again once it was put right and then came back", () => {
		watch.before("call-1", [QUEST]);
		put(QUEST, "lab/results.csv");
		watch.after("call-1");
		watch.before("call-2", [QUEST]);
		remove(QUEST, "lab");
		watch.after("call-2");
		watch.before("call-3", [QUEST]);
		put(QUEST, "lab/results.csv");
		expect(watch.after("call-3")).toContain("lab");
	});

	it("reports raw data in attachments and a link that leads nowhere", () => {
		watch.before("call-1", [QUEST]);
		put(QUEST, "attachments/events.jsonl");
		put(QUEST, "README.md", "# Quest\n\n![c](attachments/cost.png)\n");
		const report = watch.after("call-1") ?? "";
		expect(report).toContain("attachments/events.jsonl");
		expect(report).toContain("raw data");
		expect(report).toContain("attachments/cost.png");
	});

	it("says nothing for a call it never saw start", () => {
		put(QUEST, "lab/results.csv");
		expect(watch.after("unknown")).toBeUndefined();
	});
});

describe("RecordWatch.settle", () => {
	const breakLab = () => {
		watch.before("call-1", [QUEST]);
		put(QUEST, "lab/results.csv");
		watch.after("call-1");
	};

	it("asks to continue with what the run left broken", () => {
		breakLab();
		const message = watch.settle();
		expect(message).toContain("lab");
		expect(message).toContain(join(workspaceRoot, QUEST, "lab"));
	});

	it("does not ask again for the same breakage", () => {
		breakLab();
		watch.settle();
		expect(watch.settle()).toBeUndefined();
	});

	it("does not ask once the breakage is put right", () => {
		breakLab();
		remove(QUEST, "lab");
		expect(watch.settle()).toBeUndefined();
	});

	it("leaves breakage that was there before the run alone", () => {
		put(QUEST, "lab/old.csv");
		watch.before("call-1", [QUEST]);
		watch.after("call-1");
		expect(watch.settle()).toBeUndefined();
	});
});

describe("questsTouchedBy", () => {
	const home = "/home/test";

	it("names the quests a write lands in", () => {
		const state = createQuestState({ questsRoot });
		expect(
			questsTouchedBy(
				state,
				"write",
				{ path: join(questsRoot, OTHER, "x.txt") },
				root,
				home,
			),
		).toEqual([OTHER]);
	});

	it("adds the loaded quest and the quest the shell is in for bash", () => {
		const state = createQuestState({ questsRoot });
		state.questId = QUEST;
		expect(
			questsTouchedBy(
				state,
				"bash",
				{ command: "python make_charts.py" },
				join(questsRoot, OTHER, "plans"),
				home,
			).sort(),
		).toEqual([OTHER, QUEST].sort());
	});

	it("names nothing for a tool that writes nothing", () => {
		const state = createQuestState({ questsRoot });
		state.questId = QUEST;
		expect(questsTouchedBy(state, "read", { path: "x" }, root, home)).toEqual(
			[],
		);
	});
});
