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
import { createEnvGuard, refused, succeeded } from "./_helpers";

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
async function questWithPlan(
	questsRoot = join(tmpRoot, "quests"),
	name = "Verb",
) {
	const state = createQuestState({ questsRoot });
	const run = (params: Parameters<typeof handle>[3]) =>
		handle(state, fakePi(), fakeCtx(), params);
	succeeded(await run({ action: "create", title: `${name} Quest` }));
	succeeded(await run({ action: "think", kind: "plan", note: "verbs" }));
	succeeded(await run({ action: "draft", title: `${name} Plan` }));
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

	it("adds a section a plan does not have yet, at its end", async () => {
		const { run, planPath } = await questWithPlan();
		const added = succeeded(
			await run({
				action: "section",
				title: "Kept Outcomes",
				body: "- The hold still holds.",
			}),
		);
		expect(added.message).toContain("Added the Kept Outcomes section");
		expect(readFileSync(planPath, "utf8")).toMatch(
			/Old notes\.\n\n## Kept Outcomes\n\n- The hold still holds\.\n$/,
		);
	});

	it("refuses a section the README's closed set does not name", async () => {
		const { state, run } = await questWithPlan();
		const result = await run({
			action: "section",
			id: state.questId ?? "",
			title: "Kept Outcomes",
			body: "x",
		});
		expect(result.ok === false && result.guidance).toContain(
			"No section is headed",
		);
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

	it("writes to the quest `id` names, not the loaded one", async () => {
		const { state, run } = await questWithPlan();
		const loaded = state.questId ?? "";
		const loadedDir = state.questDir ?? "";
		const made = succeeded(
			await run({ action: "create", title: "Other Quest" }),
		);
		const other = String(made.details?.id);
		const otherDir = join(state.questsRoot, other);

		const result = succeeded(
			await run({ action: "journal", id: other, note: "Noted elsewhere." }),
		);

		expect(result.message).toBe(`Added to ${other}'s Journey.`);
		expect(readFileSync(join(otherDir, "README.md"), "utf8")).toContain(
			"Noted elsewhere.",
		);
		expect(readFileSync(join(loadedDir, "README.md"), "utf8")).not.toContain(
			"Noted elsewhere.",
		);
		expect(state.questId).toBe(loaded);
	});

	it("refuses an id that is not a quest's", async () => {
		const { state, run } = await questWithPlan();
		const readmeBefore = readFileSync(
			join(state.questDir ?? "", "README.md"),
			"utf8",
		);

		const result = refused(
			await run({
				action: "journal",
				id: "QEST-20000101-NOSUCH",
				note: "Lost.",
			}),
		);

		expect(result.guidance).toContain("No quest or document has the id");
		expect(readFileSync(join(state.questDir ?? "", "README.md"), "utf8")).toBe(
			readmeBefore,
		);
	});

	it("takes a document's id as its quest's", async () => {
		const { state, run } = await questWithPlan();
		const other = await anotherQuestWithPlan(state.questsRoot);

		succeeded(
			await run({ action: "journal", id: other.planId, note: "Via plan." }),
		);

		expect(readFileSync(join(other.dir, "README.md"), "utf8")).toContain(
			"Via plan.",
		);
		expect(
			readFileSync(join(state.questDir ?? "", "README.md"), "utf8"),
		).not.toContain("Via plan.");
	});
});

/**
 * A second quest with a plan in build, made by a session of its own,
 * so the session under test never had it loaded.
 */
async function anotherQuestWithPlan(questsRoot: string) {
	const { state, planPath } = await questWithPlan(questsRoot, "Other");
	return {
		id: state.questId ?? "",
		dir: state.questDir ?? "",
		planId: state.documentId ?? "",
		planPath,
	};
}

describe("documents of a quest this session has not loaded", () => {
	it("ticks another quest's plan and leaves this session where it is", async () => {
		const { state, run, planPath } = await questWithPlan();
		const other = await anotherQuestWithPlan(state.questsRoot);
		const here = { id: state.questId, doc: state.documentPath };

		succeeded(await run({ action: "tick", id: other.planId, query: "first" }));

		expect(readFileSync(other.planPath, "utf8")).toContain("- [x] First item");
		expect(readFileSync(planPath, "utf8")).toContain("- [ ] First item");
		expect({ id: state.questId, doc: state.documentPath }).toEqual(here);
	});

	it("edits a quest's section from a session with none loaded", async () => {
		const other = await anotherQuestWithPlan(join(tmpRoot, "quests"));
		const bare = createQuestState({ questsRoot: join(tmpRoot, "quests") });

		succeeded(
			await handle(bare, fakePi(), fakeCtx(), {
				action: "section",
				id: other.id,
				title: "Purpose",
				body: "Written from afar.",
			}),
		);

		expect(readFileSync(join(other.dir, "README.md"), "utf8")).toMatch(
			/## .*Purpose\n\nWritten from afar\.\n/,
		);
		expect(bare.questId).toBeNull();
	});

	it("concludes another quest's plan and journals it there", async () => {
		const { state, run } = await questWithPlan();
		const other = await anotherQuestWithPlan(state.questsRoot);
		const here = { id: state.questId, doc: state.documentPath };
		const ownReadme = readFileSync(
			join(state.questDir ?? "", "README.md"),
			"utf8",
		);

		const result = succeeded(
			await run({ action: "conclude", id: other.planId }),
		);

		expect(result.message).toContain(`It belongs to ${other.id}`);
		expect(readFileSync(other.planPath, "utf8")).toMatch(/stage: concluded/);
		expect(readFileSync(join(other.dir, "README.md"), "utf8")).toContain(
			`Concluded plan ${other.planId}.`,
		);
		expect(readFileSync(join(state.questDir ?? "", "README.md"), "utf8")).toBe(
			ownReadme,
		);
		expect({ id: state.questId, doc: state.documentPath }).toEqual(here);
	});

	it("still runs the stage machine on the file's own stage", async () => {
		const { run } = await questWithPlan();
		const other = await anotherQuestWithPlan(join(tmpRoot, "quests"));
		succeeded(await run({ action: "conclude", id: other.planId }));

		const again = refused(await run({ action: "conclude", id: other.planId }));

		expect(again.guidance).not.toContain("not found");
	});
});

describe("retitle", () => {
	it("renames the loaded quest and journals the old title", async () => {
		const { state, run } = await questWithPlan();
		const readme = join(state.questDir ?? "", "README.md");

		const result = succeeded(
			await run({
				action: "retitle",
				id: state.questId ?? "",
				title: "Verbs That Say What They Do",
			}),
		);

		const after = readFileSync(readme, "utf8");
		expect(result.message).toContain("Verbs That Say What They Do");
		expect(after).toMatch(/^# Verbs That Say What They Do$/m);
		expect(after).not.toMatch(/^# Verb Quest$/m);
		expect(after).toContain(
			'Retitled from "Verb Quest" to "Verbs That Say What They Do".',
		);
		expect(state.questTitle).toBe("Verbs That Say What They Do");
	});

	it("renames a document and journals it in its quest", async () => {
		const { state, run, planPath } = await questWithPlan();
		const planId = state.documentId ?? "";

		succeeded(
			await run({ action: "retitle", id: planId, title: "Verbs, Planned" }),
		);

		const plan = readFileSync(planPath, "utf8");
		expect(plan).toMatch(/^# Verbs, Planned$/m);
		expect(plan).not.toMatch(/^# Verb Plan$/m);
		expect(plan).toContain("## Work\n\n- [ ] First item");
		expect(
			readFileSync(join(state.questDir ?? "", "README.md"), "utf8"),
		).toContain(`Retitled ${planId} from "Verb Plan" to "Verbs, Planned".`);
	});

	it("renames a quest this session has not loaded, and stays put", async () => {
		const { state, run } = await questWithPlan();
		const other = await anotherQuestWithPlan(state.questsRoot);
		const here = { id: state.questId, title: state.questTitle };

		succeeded(
			await run({ action: "retitle", id: other.id, title: "Other, Renamed" }),
		);

		expect(readFileSync(join(other.dir, "README.md"), "utf8")).toMatch(
			/^# Other, Renamed$/m,
		);
		expect({ id: state.questId, title: state.questTitle }).toEqual(here);
	});

	it("refuses without an id, so a rename always says what it renames", async () => {
		const { run } = await questWithPlan();
		const result = refused(await run({ action: "retitle", title: "Anything" }));
		expect(result.guidance).toContain("`id`");
	});

	it("refuses an empty or multi-line title", async () => {
		const { state, run } = await questWithPlan();
		const id = state.questId ?? "";
		refused(await run({ action: "retitle", id, title: "  " }));
		refused(await run({ action: "retitle", id, title: "One\nTwo" }));
	});

	it("says so when the title already reads that way", async () => {
		const { state, run } = await questWithPlan();
		const result = succeeded(
			await run({
				action: "retitle",
				id: state.questId ?? "",
				title: "Verb Quest",
			}),
		);
		expect(result.message).toContain("already");
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
