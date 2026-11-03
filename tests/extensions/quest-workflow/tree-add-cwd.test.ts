import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	clearTreeProviders,
	registerBuiltinTreeProviders,
} from "../../../lib/core/tree/index.ts";
import { freshRepo, git } from "../../support/git-fixture.ts";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;
let repoRoot: string;

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

const envGuard = createEnvGuard();

beforeEach(async () => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "tree-add-cwd-state-"));
	repoRoot = await freshRepo("tree-add-cwd-repo");
	// Empty, so git never tracked it in the template either.
	mkdirSync(join(repoRoot, "areas", "tools"), { recursive: true });
	clearTreeProviders();
	registerBuiltinTreeProviders();
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	rmSync(repoRoot, { recursive: true, force: true });
	clearTreeProviders();
	envGuard.leave();
});

describe("tree-add from a repo subdirectory", () => {
	it("resolves the enclosing git root rather than failing on the subdir", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const created = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Code Stream",
		});
		if (!created.ok) throw new Error(created.guidance);
		const subdir = join(repoRoot, "areas", "tools");
		const result = await handle(state, fakePi(), fakeCtx(subdir), {
			action: "tree-add",
			name: "feature-x",
			cwd: subdir,
		});
		expect(result.ok).toBe(true);
	});
});

// pi read no AGENTS.md from a repo the session did not start in, so the
// tree's answer is where the session learns that repo's rules.
describe("tree-add in a repo the session did not start in", () => {
	it("says the repo's rules once, and not again for a second tree", async () => {
		writeFileSync(join(repoRoot, "AGENTS.md"), "Run the test pyramid.\n");
		await git(repoRoot, "add", "AGENTS.md");
		await git(repoRoot, "commit", "-q", "-m", "rules");
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const created = await handle(state, fakePi(), fakeCtx(tmpRoot), {
			action: "create",
			title: "Builder",
		});
		if (!created.ok) throw new Error(created.guidance);
		const id = `rules-${process.pid}-${Date.now()}`;
		const session = {
			cwd: tmpRoot,
			sessionManager: { getSessionId: () => id },
		} as unknown as Parameters<typeof handle>[2];

		const first = await handle(state, fakePi(), session, {
			action: "tree-add",
			name: "first",
			cwd: repoRoot,
		});
		if (!first.ok) throw new Error(first.guidance);
		expect(first.message).toContain("Run the test pyramid.");

		const second = await handle(state, fakePi(), session, {
			action: "tree-add",
			name: "second",
			cwd: repoRoot,
		});
		if (!second.ok) throw new Error(second.guidance);
		expect(second.message).not.toContain("Run the test pyramid.");
	});
});
