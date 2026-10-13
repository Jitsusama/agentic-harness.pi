/**
 * The verbs that edit a quest document's body under the lock, and the
 * gate that sends hand edits of owned front matter to them.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { questVerdicts } from "../../../extensions/quest-workflow/enforce";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { createEnvGuard, succeeded } from "./_helpers";

let tmpRoot: string;
const envGuard = createEnvGuard();

function fakePi() {
	return {
		setSessionName: () => {},
		appendEntry: () => {},
	} as unknown as Parameters<typeof handle>[1];
}
function fakeCtx() {
	return {
		cwd: tmpRoot,
		sessionManager: {
			getSessionId: () => undefined,
			isPersisted: () => false,
			getEntries: () => [],
		},
	} as unknown as Parameters<typeof handle>[2];
}

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "document-verbs-"));
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

/** A loaded quest with a plan in build, focused, holding two items. */
async function questWithPlan() {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const run = (params: Parameters<typeof handle>[3]) =>
		handle(state, fakePi(), fakeCtx(), params);
	succeeded(await run({ action: "create", title: "Verb Quest" }));
	succeeded(await run({ action: "think", kind: "plan", note: "verbs" }));
	succeeded(await run({ action: "draft", title: "Verb Plan" }));
	const planPath = state.documentPath ?? "";
	const text = readFileSync(planPath, "utf8");
	const head = text.slice(0, text.indexOf("\n---\n") + 5);
	writeFileSync(
		planPath,
		`${head}# Verb Plan\n\n## Work\n\n- [ ] First item\n- [ ] Second item\n\n## Notes\n\nOld notes.\n`,
	);
	succeeded(await run({ action: "build" }));
	return {
		state,
		run,
		planPath,
		head: readFileSync(planPath, "utf8").slice(0, head.length),
	};
}

describe("tick and untick", () => {
	it("ticks the focused plan's item and counts it", async () => {
		const { state, run, planPath } = await questWithPlan();
		const result = succeeded(await run({ action: "tick", query: "first" }));

		expect(result.message).toContain("Ticked");
		expect(readFileSync(planPath, "utf8")).toContain("- [x] First item");
		expect(state.done).toBe(1);
	});

	it("leaves the front matter byte for byte as it was", async () => {
		const { run, planPath, head } = await questWithPlan();
		succeeded(await run({ action: "tick", query: "second" }));
		succeeded(await run({ action: "untick", query: "second" }));
		expect(readFileSync(planPath, "utf8").startsWith(head)).toBe(true);
	});

	it("refuses an item it cannot pick out", async () => {
		const { run } = await questWithPlan();
		const result = await run({ action: "tick", query: "item" });
		expect(result.ok).toBe(false);
	});
});

describe("section", () => {
	it("replaces one section of the focused plan", async () => {
		const { run, planPath } = await questWithPlan();
		succeeded(
			await run({ action: "section", title: "Notes", body: "New notes." }),
		);
		const text = readFileSync(planPath, "utf8");
		expect(text).toContain("## Notes\n\nNew notes.\n");
		expect(text).not.toContain("Old notes.");
	});

	it("edits the README when named by the quest's id", async () => {
		const { state, run } = await questWithPlan();
		succeeded(
			await run({
				action: "section",
				id: state.questId ?? "",
				title: "Purpose",
				body: "Why this quest exists.",
			}),
		);
		const readme = readFileSync(
			join(state.questDir ?? "", "README.md"),
			"utf8",
		);
		expect(readme).toMatch(/## .*Purpose\n\nWhy this quest exists\.\n/);
	});
});

describe("journal", () => {
	it("adds a dated entry to the quest's Journey", async () => {
		const { state, run } = await questWithPlan();
		succeeded(await run({ action: "journal", note: "Landed the verbs." }));
		const readme = readFileSync(
			join(state.questDir ?? "", "README.md"),
			"utf8",
		);
		expect(readme).toMatch(/- \*\*\d{4}-\d{2}-\d{2}\*\*: Landed the verbs\./);
	});
});

describe("hand edits of owned front matter", () => {
	it("are refused with the verb that owns the field", async () => {
		const { state, planPath } = await questWithPlan();
		const verdicts = questVerdicts(
			state,
			"edit",
			{
				path: planPath,
				edits: [{ oldText: "stage: build", newText: "stage: concluded" }],
			},
			tmpRoot,
		);
		const owned = verdicts.find((v) => v.guard === "quest-owned-fields");
		expect(owned?.reason).toContain("`conclude`");
	});

	it("let everything else in the file through", async () => {
		const { state, planPath } = await questWithPlan();
		const verdicts = questVerdicts(
			state,
			"edit",
			{
				path: planPath,
				edits: [{ oldText: "Old notes.", newText: "Edited notes." }],
			},
			tmpRoot,
		);
		expect(
			verdicts.find((v) => v.guard === "quest-owned-fields"),
		).toBeUndefined();
	});

	it("catch a whole-file write that drops the stage", async () => {
		const { state, planPath } = await questWithPlan();
		const verdicts = questVerdicts(
			state,
			"write",
			{ path: planPath, content: "# Verb Plan\n" },
			tmpRoot,
		);
		expect(
			verdicts.find((v) => v.guard === "quest-owned-fields")?.reason,
		).toContain("`stage`");
	});
});
