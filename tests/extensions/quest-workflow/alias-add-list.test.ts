import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../lib/refs/index";
import { createEnvGuard } from "./_helpers";

let tmpRoot: string;

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

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "alias-add-list-"));
	registerBuiltinRefTypes();
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	clearRefTypes();
	envGuard.leave();
});

describe("alias-add with a list", () => {
	it("adds every ref in a comma-separated list", async () => {
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		const ctx = fakeCtx(tmpRoot);
		const created = await handle(state, fakePi(), ctx, {
			action: "create",
			title: "Linked Work",
		});
		if (!created.ok) throw new Error(created.guidance);
		const result = await handle(state, fakePi(), ctx, {
			action: "alias-add",
			ref: "github-pr:shop/world#1, github-issue:shop/world#2",
		});
		expect(result.ok).toBe(true);
		const readme = readFileSync(
			join(state.questDir ?? "", "README.md"),
			"utf8",
		);
		// Two distinct aliases with clean values, not one alias whose
		// value swallowed the rest of the list.
		expect(readme).toMatch(/type: github-pr/);
		expect(readme).toMatch(/type: github-issue/);
		expect(readme).toMatch(/value: shop\/world#2/);
		expect(readme).not.toMatch(/value: 'shop\/world#1,/);
		expect(readme).not.toMatch(/value: "shop\/world#1,/);
	});
});
