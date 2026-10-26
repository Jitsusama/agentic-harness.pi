/**
 * Marking a quest as orchestrating, and clearing the mark.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import { parseQuestFrontMatter } from "../../../lib/internal/quest/frontmatter";
import { createEnvGuard, journeyOf, refused, succeeded } from "./_helpers";

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
	tmpRoot = mkdtempSync(join(tmpdir(), "orchestrate-"));
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

async function loadedQuest() {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const run = (params: Parameters<typeof handle>[3]) =>
		handle(state, fakePi(), fakeCtx(), params);
	succeeded(await run({ action: "create", title: "Mission Quest" }));
	const readme = join(state.questDir ?? "", "README.md");
	const marked = () =>
		parseQuestFrontMatter(readFileSync(readme, "utf8"))?.frontMatter
			.orchestrator;
	return { state, run, marked };
}

describe("orchestrate", () => {
	it("marks the loaded quest, names its group and journals it", async () => {
		const { state, run, marked } = await loadedQuest();
		const address = (state.questId ?? "").split("-").pop()?.toLowerCase();

		const result = succeeded(await run({ action: "orchestrate" }));

		expect(marked()).toBe(true);
		expect(result.message).toContain(`#orchestration/${address}`);
		expect(journeyOf(state.questDir ?? "")).toContain(
			"Marked as orchestrating",
		);
	});

	it("says so and writes nothing when the quest already orchestrates", async () => {
		const { run } = await loadedQuest();
		succeeded(await run({ action: "orchestrate" }));

		const again = succeeded(await run({ action: "orchestrate" }));

		expect(again.message).toContain("already orchestrates");
	});

	it("clears the mark with unorchestrate", async () => {
		const { state, run, marked } = await loadedQuest();
		succeeded(await run({ action: "orchestrate" }));

		succeeded(await run({ action: "unorchestrate" }));

		expect(marked()).toBeUndefined();
		expect(journeyOf(state.questDir ?? "")).toContain(
			"No longer orchestrating",
		);
	});

	it("refuses a document: only a quest orchestrates", async () => {
		const { state, run } = await loadedQuest();
		succeeded(await run({ action: "think", kind: "plan", note: "x" }));
		succeeded(await run({ action: "draft", title: "A Plan" }));

		refused(await run({ action: "orchestrate", id: state.documentId ?? "" }));
	});
});
