/**
 * The subjects a quest's sessions say they work on, set on the quest so
 * every session on it declares the same and a need finds them by them.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import { parseQuestFrontMatter } from "../../../../lib/internal/quest/documents/frontmatter.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { createEnvGuard } from "../_helpers.ts";

let tmpRoot: string;

function fakeCtx() {
	return {
		cwd: tmpRoot,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}

function questsRoot() {
	return join(tmpRoot, "quests");
}

async function run(params: Parameters<typeof handle>[3]) {
	return handle(
		createQuestState({ questsRoot: questsRoot() }),
		fakePi(),
		fakeCtx(),
		params,
	);
}

async function made(): Promise<string> {
	const result = await run({ action: "create", title: "Needs Find Cells" });
	if (!result.ok) throw new Error(result.guidance);
	return (result.details as { id: string }).id;
}

function subjectsOf(id: string) {
	const readme = readFileSync(join(questsRoot(), id, "README.md"), "utf8");
	return parseQuestFrontMatter(readme)?.frontMatter._extra?.subjects;
}

const said = (result: Awaited<ReturnType<typeof run>>) =>
	result.ok ? result.message : result.guidance;

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "subjects-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("the subjects a quest's sessions declare", () => {
	it("are set as a list, each trimmed, once each, and cleared again", async () => {
		const id = await made();
		const before = subjectsOf(id);
		const set = await run({
			action: "config",
			id,
			ref: "subjects= mycelium:hubs , needs,,needs",
		});
		const listed = subjectsOf(id);
		const cleared = await run({ action: "config", id, ref: "subjects=" });
		expect(
			[before, set.ok, listed, cleared.ok, subjectsOf(id)],
			"unset, set, listed, cleared, unset",
		).toEqual([undefined, true, ["mycelium:hubs", "needs"], true, undefined]);
	});

	it("say what was set, and that a need finds the sessions by them", async () => {
		const id = await made();
		const result = await run({ action: "config", id, ref: "subjects=needs" });
		expect(said(result)).toMatch(/needs/);
		expect(said(result)).toMatch(/from their next refresh/);
	});

	it("refuse more than the node reads, or one it would pass over, changing nothing", async () => {
		const id = await made();
		const many = Array.from({ length: 13 }, (_, at) => `s${at}`).join(",");
		const tooMany = await run({
			action: "config",
			id,
			ref: `subjects=${many}`,
		});
		const tooLong = await run({
			action: "config",
			id,
			ref: `subjects=${"x".repeat(121)}`,
		});
		expect(
			[tooMany.ok, tooLong.ok, subjectsOf(id)],
			"both refused, nothing set",
		).toEqual([false, false, undefined]);
		expect(said(tooMany)).toMatch(/12/);
	});

	it("are said for a named quest, and how to set them in the plain report", async () => {
		const id = await made();
		await run({ action: "config", id, ref: "subjects=needs,hubs" });
		const report = await run({ action: "config", id });
		const plain = await run({ action: "config" });
		expect([said(report), said(plain)]).toEqual([
			expect.stringContaining("needs, hubs"),
			expect.stringContaining("subjects="),
		]);
	});
});
