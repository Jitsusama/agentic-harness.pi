/**
 * How a quest's sessions hear the mesh, set on the quest so it holds
 * through restarts and respawns and every session on it hears the same.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

	// 85PKB2 on #1405: the router is the quest someone will open and
	// edit, so a slip by hand has to show rather than vanish.
	it("keeps a way of hearing written by hand it can't read, and says so", async () => {
		const id = await made();
		const path = join(questsRoot(), id, "README.md");
		const readme = readFileSync(path, "utf8");
		writeFileSync(path, readme.replace(/^id: .*$/m, "$&\nhears: adressed"));
		const parsed = parseQuestFrontMatter(readFileSync(path, "utf8"));
		const kept = parsed ? serializeQuestFrontMatter(parsed.frontMatter) : "";
		const report = await run({ action: "config", id });
		await run({ action: "config", id, ref: "hears=addressed" });
		expect(
			[
				kept.includes("hears: adressed"),
				report.ok ? report.message : report.guidance,
				hearsOf(id),
				readFileSync(path, "utf8").includes("adressed"),
			],
			"kept through a rewrite, reported, then set right",
		).toEqual([
			true,
			expect.stringContaining('"adressed" isn\'t a way of hearing'),
			"addressed",
			false,
		]);
	});

	it("says how a named quest hears", async () => {
		const id = await made();
		const before = await run({ action: "config", id });
		await run({ action: "config", id, ref: "hears=addressed" });
		const after = await run({ action: "config", id });
		expect(
			[before, after].map((r) => (r.ok ? r.message : r.guidance)),
			"as every peer, then only what is put to them",
		).toEqual([
			expect.stringContaining("hear as every peer does"),
			expect.stringContaining("hear only what is put to them"),
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
