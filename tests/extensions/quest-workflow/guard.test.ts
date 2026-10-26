import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type QuestVerdict,
	questVerdicts,
} from "../../../extensions/quest-workflow/enforce";
import { applyQuestGuards } from "../../../extensions/quest-workflow/guard";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	clearTreeProviders,
	registerBuiltinTreeProviders,
} from "../../../lib/core/tree/index.ts";
import { forgetRedirects } from "../../../lib/guardian/apply.ts";
import {
	restoreSessionModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import {
	type GuardReport,
	setGuardReportSink,
} from "../../../lib/guardian/report.ts";
import {
	declareGuards,
	GUARDS,
} from "../../../lib/internal/guardian/guards.ts";
import { freshRepo, git } from "../../support/git-fixture.ts";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;
let repoRoot: string;
let reports: GuardReport[];
const noScratch = { tempRoots: [] as string[] };
const envGuard = createEnvGuard();

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}
function fakeCtx(cwd: string) {
	return {
		cwd,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}

async function questInBuild() {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const steps = [
		{ action: "create", title: "Guarded Quest" },
		{ action: "think", kind: "plan", note: "Exploring" },
		{ action: "draft", title: "First plan" },
	];
	for (const step of steps) {
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot), step);
		if (!result.ok) throw new Error(result.guidance);
	}
	await handle(state, fakePi(), fakeCtx(repoRoot), { action: "build" });
	return state;
}

beforeEach(async () => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "quest-guard-"));
	repoRoot = await freshRepo("quest-guard-repo");
	clearTreeProviders();
	registerBuiltinTreeProviders();
	declareGuards(
		GUARDS.questRecord,
		GUARDS.questDocumentRead,
		GUARDS.questTemp,
		GUARDS.questPlanStage,
		GUARDS.questUntrackedTree,
		GUARDS.questHomeless,
	);
	restoreSessionModes({});
	forgetRedirects();
	reports = [];
	setGuardReportSink((r) => reports.push(r));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	rmSync(repoRoot, { recursive: true, force: true });
	clearTreeProviders();
	setGuardReportSink(undefined);
	restoreSessionModes({});
	envGuard.leave();
});

describe("where a bash write lands", () => {
	it("reads ~ as the home directory, not a folder in the cwd", async () => {
		const state = await questInBuild();

		const verdicts = questVerdicts(
			state,
			"bash",
			{ command: "mkdir -p ~/src && echo hi > ~/src/foo.ts" },
			tmpRoot,
			{ ...noScratch, home: repoRoot },
		);

		expect(verdicts.map((v) => v.guard)).toEqual(["quest-untracked-tree"]);
		expect(verdicts[0]?.adopt).toBe(repoRoot);
	});

	it("leaves any quest's record to the record gate", async () => {
		const state = await questInBuild();
		const sibling = join(state.questsRoot, "QEST-20260101-OTHER1", "README.md");

		const verdicts = questVerdicts(
			state,
			"edit",
			{ path: sibling },
			tmpRoot,
			noScratch,
		);

		expect(verdicts.map((v) => v.guard)).not.toContain("quest-homeless");
	});
});

describe("a quest document read from the shell", () => {
	it("is sent to quest show once, and goes through when asked again", async () => {
		const state = await questInBuild();
		const plan = join(
			state.questsRoot,
			"QEST-20261025-85PKB2",
			"plans",
			"PLAN-20261025-QR647O.md",
		);
		const input = { command: `grep -n "^## " ${plan}` };
		const call = () => `bash ${JSON.stringify(input)}`;
		const verdicts = () =>
			questVerdicts(state, "bash", input, tmpRoot, noScratch);

		expect(verdicts().map((v) => v.guard)).toContain("quest-document-read");
		const first = applyQuestGuards(state, verdicts(), undefined, call);
		const again = applyQuestGuards(state, verdicts(), undefined, call);

		expect(first?.reason).toContain(
			"`quest show` with id PLAN-20261025-QR647O",
		);
		expect(again).toBeUndefined();
		expect(reports.map((r) => r.kind)).toEqual(["overridden"]);
	});
});

describe("the quest gates under the policy", () => {
	const untracked = (root: string): QuestVerdict => ({
		guard: "quest-untracked-tree",
		adopt: root,
		block: true,
		reason: "adopt it",
	});

	it("adopts an untracked tree by default and lets the write through", async () => {
		const state = await questInBuild();
		const adopted: string[] = [];

		const result = applyQuestGuards(
			state,
			[untracked(repoRoot)],
			(_s, root) => {
				adopted.push(root);
				return { ok: true };
			},
		);

		expect(result).toBeUndefined();
		expect(adopted).toEqual([repoRoot]);
		expect(reports.map((r) => r.kind)).toEqual(["fixed"]);
	});

	it("lets the write through and says why when the tree cannot be adopted", async () => {
		const state = await questInBuild();

		const result = applyQuestGuards(state, [untracked(repoRoot)], () => ({
			ok: false,
			why: "a main working tree",
		}));

		expect(result).toBeUndefined();
		expect(reports).toMatchObject([{ kind: "waved" }]);
		expect(reports[0]?.body).toContain("a main working tree");
	});

	it("says a tree it cannot adopt only once", async () => {
		const state = await questInBuild();
		const refuse = () => ({ ok: false as const, why: "a main working tree" });

		applyQuestGuards(state, [untracked(repoRoot)], refuse);
		const second = applyQuestGuards(state, [untracked(repoRoot)], refuse);

		expect(second).toBeUndefined();
		expect(reports).toHaveLength(1);
	});

	it("refuses as before once the guard blocks", async () => {
		const state = await questInBuild();
		setSessionMode("quest-untracked-tree", "block");

		const result = applyQuestGuards(state, [untracked(repoRoot)], () => {
			throw new Error("must not adopt in block mode");
		});

		expect(result).toEqual({ block: true, reason: "adopt it" });
	});

	it("does not let a gate that is off hide a blocking one after it", async () => {
		const state = await questInBuild();
		setSessionMode("quest-temp", "off");
		setSessionMode("quest-homeless", "block");

		const result = applyQuestGuards(state, [
			{ guard: "quest-temp", block: true, reason: "temp" },
			{ guard: "quest-homeless", block: true, reason: "homeless" },
		]);

		expect(result).toEqual({ block: true, reason: "homeless" });
		expect(reports.map((r) => r.guard)).toEqual(["quest-temp"]);
	});

	it("refuses a homeless write with its remedy, then lets the same write through", async () => {
		// Most of what this gate refused since June was work that was fine,
		// and the agent could only hunt for a way round it. Now it hears why,
		// and making the same write again goes through, shown to the person.
		const state = await questInBuild();
		const homeless: QuestVerdict = {
			guard: "quest-homeless",
			block: true,
			reason: "outside every git tree",
		};
		const write = () => 'write {"path":"/home/me/.config/x"}';

		const first = applyQuestGuards(state, [homeless], undefined, write);
		const again = applyQuestGuards(state, [homeless], undefined, write);

		expect(first?.reason).toMatch(
			/outside every git tree\n\n.*same call again/s,
		);
		expect(again).toBeUndefined();
		expect(reports.map((r) => r.kind)).toEqual(["overridden"]);
	});

	it("refuses a different write afresh", async () => {
		const state = await questInBuild();
		const homeless: QuestVerdict = {
			guard: "quest-homeless",
			block: true,
			reason: "outside every git tree",
		};

		applyQuestGuards(state, [homeless], undefined, () => "write a");

		expect(
			applyQuestGuards(state, [homeless], undefined, () => "write b"),
		).toMatchObject({ block: true });
	});

	it("adopts a linked worktree through the quest's own verb", async () => {
		const state = await questInBuild();
		const linked = join(tmpRoot, "linked");
		await git(repoRoot, "worktree", "add", "-q", "-b", "linked", linked);
		const write = { path: join(linked, "src/foo.ts") };
		const before = questVerdicts(state, "write", write, linked, noScratch);

		applyQuestGuards(state, before);

		expect(reports.map((r) => r.kind)).toEqual(["fixed"]);
		expect(questVerdicts(state, "write", write, linked, noScratch)).toEqual([]);
	});

	it("notes what it lets through outside every tree, and nothing it refused", async () => {
		const state = await questInBuild();
		const noted: string[][] = [];
		const note = (_s: unknown, paths: string[]) => noted.push(paths);
		const homeless: QuestVerdict = {
			guard: "quest-homeless",
			block: true,
			reason: "outside every git tree",
			outside: ["/home/me/.config/x", "/home/me/.config/x"],
		};
		const write = () => 'write {"path":"/home/me/.config/x"}';

		applyQuestGuards(state, [homeless], undefined, write, note);
		expect(noted).toEqual([]);

		applyQuestGuards(state, [homeless], undefined, write, note);
		expect(noted).toEqual([["/home/me/.config/x"]]);
	});

	it("names each homeless target of a bash write for the note", async () => {
		const state = await questInBuild();
		const loose = join(tmpRoot, "loose");

		const verdicts = questVerdicts(
			state,
			"bash",
			{ command: `echo a > ${loose}/a.txt && echo b > ${loose}/b.txt` },
			tmpRoot,
			noScratch,
		);

		expect(verdicts).toMatchObject([
			{
				guard: "quest-homeless",
				outside: [join(loose, "a.txt"), join(loose, "b.txt")],
			},
		]);
	});

	it("lets a write into a main checkout through, untracked", async () => {
		const state = await questInBuild();
		const write = { path: join(repoRoot, "src/foo.ts") };

		const result = applyQuestGuards(
			state,
			questVerdicts(state, "write", write, repoRoot, noScratch),
		);

		expect(result).toBeUndefined();
		expect(reports[0]?.body).toMatch(/main working tree/);
	});
});
