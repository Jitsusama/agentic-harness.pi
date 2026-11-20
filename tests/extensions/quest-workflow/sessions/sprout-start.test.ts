/**
 * A sprouted session's start makes, marks and ties its own quest from
 * the node's seed, once, and leaves the prose path standing whenever
 * the seed is missing or out of shape.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	pendingWords,
	resolveStartup,
} from "../../../../extensions/quest-workflow/lifecycle.ts";
import {
	type Create,
	startSprouted,
} from "../../../../extensions/quest-workflow/sprout-start.ts";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { create } from "../../../../extensions/quest-workflow/verbs/lifecycle.ts";
import {
	buildAliasIndex,
	lookupAliasDetail,
} from "../../../../lib/internal/quest/creation/alias-index.ts";
import { discoverQuests } from "../../../../lib/internal/quest/discovery/discovery.ts";
import type { RunProgram } from "../../../../lib/mesh/sprout.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { createEnvGuard } from "../_helpers.ts";

const SEED = "QUEST_WORKFLOW_SPROUT";
const PROSE = "QUEST_WORKFLOW_FIRST_TEXT";

let tmpRoot: string;
let savedHome: string | undefined;
const envGuard = createEnvGuard();

/** A fresh session's context, with no history to restore. */
function ctxOf(sessionId = "sess-1") {
	return {
		cwd: tmpRoot,
		sessionManager: {
			getSessionId: () => sessionId,
			isPersisted: () => true,
			getEntries: () => [],
		},
	} as unknown as Parameters<typeof resolveStartup>[2];
}

/** A start as session_start runs it: resolve, then sprout. */
async function start(
	seed: Record<string, unknown> | undefined,
	options: { run?: RunProgram; asked?: unknown[]; sessionId?: string } = {},
) {
	if (seed) process.env[SEED] = JSON.stringify({ v: 1, ...seed });
	process.env[PROSE] = "the node's prose";
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const pi = fakePi();
	const ctx = ctxOf(options.sessionId);
	const source = resolveStartup(state, pi, ctx).source;
	// A link's page is fetched over the network, so a test makes the
	// quest from its title alone and keeps what it was asked.
	const make: Create = (params) => {
		options.asked?.push(params);
		return create(state, pi, ctx, {
			...params,
			url: undefined,
			title: params.title ?? "From the link's page",
		});
	};
	const run: RunProgram =
		options.run ?? (async () => ({ code: 0, stdout: "", stderr: "" }));
	await startSprouted(state, pi, ctx, options.sessionId ?? "sess-1", {
		create: make,
		run,
	});
	return { state, source, words: pendingWords(ctx).hints?.firstWords };
}

/** The quests on disk. */
function questIds(): string[] {
	return [...discoverQuests(join(tmpRoot, "quests")).index.quests.keys()];
}

/** The quest carrying alias sprout:`value`, if one does. */
function sproutedQuest(value: string): string | undefined {
	const { index } = discoverQuests(join(tmpRoot, "quests"));
	const found = lookupAliasDetail(buildAliasIndex(index), {
		type: "sprout",
		value,
	});
	return found.kind === "hit" ? found.questId : undefined;
}

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "sprout-start-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
});
afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	delete process.env[SEED];
	delete process.env[PROSE];
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("a sprouted session's start", () => {
	it("makes and loads a quest from the words, marked as the sprout's", async () => {
		const { state, source, words } = await start({
			words: "tidy the rows\nand more",
			id: "S1",
		});
		expect(source).toBe("sprout");
		expect(state.questId).toBeTruthy();
		expect(sproutedQuest("S1")).toBe(state.questId);
		expect(words).toMatch(/is made and loaded for it from the person's words/u);
		expect(words).not.toMatch(/quest create/u);
	});

	it("makes it from a link, with the words as its note", async () => {
		const asked: unknown[] = [];
		const { state, words } = await start(
			{ link: "https://github.com/o/r/pull/1", words: "this one" },
			{ asked },
		);
		expect(asked[0]).toMatchObject({
			kind: "quest",
			priority: "driving",
			url: "https://github.com/o/r/pull/1",
			note: "this one",
		});
		expect(state.questId).toBeTruthy();
		expect(words).toMatch(/from https:\/\/github\.com\/o\/r\/pull\/1/u);
	});

	it("ties it to the cell it came from, and says so", async () => {
		const ran: string[][] = [];
		const { state, words } = await start(
			{ words: "tea", from: "TERN02" },
			{
				run: async (_program, args) => {
					ran.push([...args]);
					return { code: 0, stdout: "", stderr: "" };
				},
			},
		);
		expect(ran).toEqual([
			[
				"web",
				state.questId,
				"tie",
				state.questId,
				"TERN02",
				"--how",
				"sprouted-from",
			],
		]);
		expect(words).toMatch(/tied on the map to the cell it came from, TERN02/u);
	});

	it("still starts when the tie fails, saying the command to run", async () => {
		const { state, words } = await start(
			{ words: "tea", from: "TERN02" },
			{ run: async () => ({ code: 1, stdout: "", stderr: "no such cell\n" }) },
		);
		expect(state.questId).toBeTruthy();
		expect(words).toMatch(/failed \(no such cell\); run `mycelium web /u);
	});

	it("makes no second quest when its environment is replayed", async () => {
		await start({ words: "tea", id: "S2" });
		const before = questIds();
		const again = await start({ words: "tea", id: "S2" });
		expect(questIds()).toEqual(before);
		expect(again.words).toBe("");
	});

	it("leaves the prose path when from isn't an address", async () => {
		const { state, source, words } = await start({
			words: "tea",
			from: "TERN02 --how x",
		});
		expect(source).not.toBe("sprout");
		expect(state.questId).toBeFalsy();
		expect(questIds()).toEqual([]);
		expect(words).toBe("the node's prose");
	});

	it("leaves the prose path when there is no seed", async () => {
		const { state, words } = await start(undefined);
		expect(state.questId).toBeFalsy();
		expect(words).toBe("the node's prose");
	});
});
