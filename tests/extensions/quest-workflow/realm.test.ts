/**
 * A quest says which realm it was made in, so what reads quests across
 * realms (Estuary's inlet) can let only the right ones cross, and an
 * unmarked quest never does.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../extensions/quest-workflow/transitions.ts";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../lib/internal/quest/frontmatter.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { createEnvGuard } from "./_helpers.ts";

let tmpRoot: string;

function fakeCtx() {
	return {
		cwd: tmpRoot,
		sessionManager: { getSessionId: () => "sess-1" },
	} as unknown as Parameters<typeof handle>[2];
}

/** The front matter of a quest made by a session in `realm`, if any. */
async function madeIn(realm: string | undefined) {
	if (realm !== undefined) vi.stubEnv("MYCELIUM_REALM", realm);
	const questsRoot = join(tmpRoot, "quests");
	const result = await handle(
		createQuestState({ questsRoot }),
		fakePi(),
		fakeCtx(),
		{ action: "create", title: "Somewhere" },
	);
	if (!result.ok) throw new Error(result.guidance);
	const id = (result.details as { id: string }).id;
	const readme = readFileSync(join(questsRoot, id, "README.md"), "utf8");
	return { readme, frontMatter: parseQuestFrontMatter(readme)?.frontMatter };
}

const envGuard = createEnvGuard();
let savedHome: string | undefined;
beforeEach(() => {
	envGuard.enter();
	vi.stubEnv("MYCELIUM_REALM", "");
	vi.stubEnv("PI_HOME_REALM", "");
	tmpRoot = mkdtempSync(join(tmpdir(), "realm-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	vi.unstubAllEnvs();
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("the realm a quest was made in", () => {
	it("is written as the session's realm when the quest is made", async () => {
		const { readme, frontMatter } = await madeIn("work");
		expect(
			[frontMatter?.realm, /^realm: work$/m.test(readme)],
			"the realm, read back and on disk",
		).toEqual(["work", true]);
	});

	it("is left out when the session names no realm", async () => {
		const { readme, frontMatter } = await madeIn(undefined);
		expect(
			[frontMatter?.realm, readme.includes("realm:")],
			"no realm at all",
		).toEqual([undefined, false]);
	});

	it("is left out when the realm named couldn't be a folder", async () => {
		const { frontMatter } = await madeIn("Work Stuff");
		expect(frontMatter?.realm, "an unnamed realm marks nothing").toBe(
			undefined,
		);
	});

	it("survives a rewrite of the front matter", async () => {
		const { frontMatter } = await madeIn("work");
		if (frontMatter === undefined) throw new Error("no front matter");
		const again = parseQuestFrontMatter(
			`${serializeQuestFrontMatter(frontMatter)}\n# Somewhere\n`,
		);
		expect(again?.frontMatter.realm, "still work").toBe("work");
	});
});
