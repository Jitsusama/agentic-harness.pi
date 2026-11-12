/**
 * How a quest's sessions hear the mesh, set on the quest so it holds
 * through restarts and respawns and every session on it hears the same.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../extensions/quest-workflow/transitions.ts";
import { parseQuestFrontMatter } from "../../../lib/internal/quest/frontmatter.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { createEnvGuard } from "./_helpers.ts";

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
	const result = await run({ action: "create", title: "The Void" });
	if (!result.ok) throw new Error(result.guidance);
	return (result.details as { id: string }).id;
}

function hearsOf(id: string) {
	const readme = readFileSync(join(questsRoot(), id, "README.md"), "utf8");
	return parseQuestFrontMatter(readme)?.frontMatter.hears;
}

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "hears-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("how a quest's sessions hear the mesh", () => {
	it("is set to hear only what is put to them, and back to everything", async () => {
		const id = await made();
		const before = hearsOf(id);
		const set = await run({ action: "config", id, ref: "hears=addressed" });
		const narrowed = hearsOf(id);
		const back = await run({ action: "config", id, ref: "hears=all" });
		expect(
			[before, set.ok, narrowed, back.ok, hearsOf(id)],
			"unset, set, addressed, set, unset",
		).toEqual([undefined, true, "addressed", true, undefined]);
	});

	it("refuses a way of hearing it doesn't know, changing nothing", async () => {
		const id = await made();
		const result = await run({ action: "config", id, ref: "hears=some" });
		expect(
			[result.ok, result.ok ? "" : result.guidance, hearsOf(id)],
			"refused, naming the two ways, and unchanged",
		).toEqual([
			false,
			expect.stringContaining("hears=addressed or hears=all"),
			undefined,
		]);
	});

	it("says in the plain report how to set it", async () => {
		const result = await run({ action: "config" });
		expect(
			result.ok ? result.message : result.guidance,
			"the report names the setting",
		).toContain("hears=addressed");
	});
});
