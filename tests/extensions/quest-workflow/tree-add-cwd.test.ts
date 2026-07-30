import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	clearTreeProviders,
	registerBuiltinTreeProviders,
} from "../../../lib/tree/index";
import { freshRepo } from "../../support/git-fixture.js";
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
