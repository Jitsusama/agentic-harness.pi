/**
 * The spawn verbs: which terminal driver opens a quest's session, in
 * which folder, and for which quest.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import {
	joinSpawns,
	listedForStage,
} from "../../../../lib/internal/fence-stage.ts";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "../../../../lib/quest/index.ts";
import { registerTerminalDriver } from "../../../../lib/terminal/index.ts";
import { at } from "../../../support/at.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { fakeCtx } from "../_helpers.ts";
import { buildState, createQuest, fixture } from "../support/verbs.ts";

describe("spawn verbs", () => {
	it("dispatches the request through the registered terminal driver", async () => {
		joinSpawns("stage 1");
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: a.id,
		});

		const calls: {
			layout: string;
			cwd?: string;
			command: string | undefined;
			env?: Readonly<Record<string, string>>;
		}[] = [];
		registerTerminalDriver({
			id: "test",
			available: () => true,
			async spawn(req) {
				calls.push({
					layout: req.layout,
					cwd: req.cwd,
					command: req.command,
					env: req.env,
				});
			},
		});

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "spawn-tab",
		});
		expect(result).toMatchObject({ ok: true });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.layout).toBe("tab");
		expect(calls[0]?.command).toBe("pi");
		// With no tree registered, spawn lands in the live session's
		// cwd (the running test process, so its identity probes as
		// live), ahead of the quest dir in the resolution order.
		expect(calls[0]?.cwd).toBe(fixture.root);
		// The spawn ships the loaded quest id so the new
		// pi can name its session after the quest without
		// the wezterm/tmux tab-title plumbing.
		// It also names the words the new session is told first.
		// And the fence's first stage lists it by a token of its own.
		expect(calls[0]?.env).toEqual({
			QUEST_WORKFLOW_AUTOLOAD_ID: a.id,
			QUEST_WORKFLOW_FIRST_WORDS: expect.stringMatching(/^[0-9a-f-]{36}$/),
			PI_FENCE_STAGE: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		expect(
			listedForStage(calls.at(0)?.env?.PI_FENCE_STAGE),
			"a fresh spawn wasn't listed for the fence's first stage",
		).toBe(true);
	});

	it("prefers a registered tree path over the quest dir", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: a.id,
		});

		// Register a real tree directory in the quest frontmatter.
		const treeDir = join(fixture.root, "work-tree");
		mkdirSync(treeDir, { recursive: true });
		const readmePath = join(state.questDir as string, "README.md");
		const parsed = parseQuestFrontMatter(readFileSync(readmePath, "utf8"));
		if (!parsed) throw new Error("could not parse quest frontmatter");
		parsed.frontMatter.trees = [{ path: treeDir, providerId: "git-worktree" }];
		writeFileSync(
			readmePath,
			`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
		);

		const calls: { cwd?: string }[] = [];
		registerTerminalDriver({
			id: "test",
			available: () => true,
			async spawn(req) {
				calls.push({ cwd: req.cwd });
			},
		});

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "spawn-tab",
		});
		expect(result).toMatchObject({ ok: true });
		expect(calls[0]?.cwd).toBe(treeDir);
		if (!result.ok) throw new Error("expected ok");
		expect((result.details as { cwdSource?: string }).cwdSource).toBe("tree");
	});

	// pi finds a session by id only among the logs of the folder it starts
	// in, so a reopen opened in any other folder reopens nothing: on 14
	// November two reopens given another folder never found their sessions.
	it("reopens a session where it ran, over a folder the call named", async () => {
		const state = buildState();
		const a = await createQuest(state, "Alpha");
		const ran = join(fixture.root, "where-it-ran");
		const named = join(fixture.root, "somewhere-else");
		mkdirSync(ran, { recursive: true });
		mkdirSync(named, { recursive: true });
		const readmePath = join(fixture.root, "quests", a.id, "README.md");
		const parsed = parseQuestFrontMatter(readFileSync(readmePath, "utf8"));
		if (!parsed) throw new Error("could not parse quest frontmatter");
		parsed.frontMatter.sessions = [
			{
				id: "sess-ran",
				started: new Date().toISOString(),
				status: "active",
				cwd: ran,
			},
		];
		writeFileSync(
			readmePath,
			`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
		);
		registerTerminalDriver({
			id: "test",
			available: () => true,
			async spawn() {
				// A dry run opens nothing.
			},
		});

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "spawn-tab",
			id: a.id,
			command: "pi --session sess-ran",
			cwd: named,
			dryRun: true,
		});
		if (!result.ok) throw new Error(result.guidance);
		const details = result.details as { cwd?: string; cwdSource?: string };
		expect(details.cwd, "the reopen didn't open where its session ran").toBe(
			ran,
		);
		expect(details.cwdSource).toBe("reopened");
		expect(result.message).toContain(`not ${named}`);
	});

	// A builder subquest is spawned before it has a tree or a session, and
	// opening it in home leaves it without its repo's AGENTS.md. Its
	// parent's worktree is the parent's alone, so it opens in the checkout
	// that worktree was cut from.
	it("opens a subquest with no tree of its own in its parent's repo", async () => {
		const state = buildState();
		const parent = await createQuest(state, "Parent");
		const checkout = join(fixture.root, "checkout");
		mkdirSync(join(checkout, ".git", "worktrees", "parent-tree"), {
			recursive: true,
		});
		const treeDir = join(fixture.root, "parent-tree");
		mkdirSync(treeDir, { recursive: true });
		writeFileSync(
			join(treeDir, ".git"),
			`gitdir: ${join(checkout, ".git", "worktrees", "parent-tree")}\n`,
		);
		const parsed = parseQuestFrontMatter(readFileSync(parent.path, "utf8"));
		if (!parsed) throw new Error("could not parse quest frontmatter");
		parsed.frontMatter.trees = [{ path: treeDir, providerId: "git-worktree" }];
		writeFileSync(
			parent.path,
			`${serializeQuestFrontMatter(parsed.frontMatter)}\n${parsed.body}`,
		);
		const child = await handle(
			state,
			fakePi(),
			{
				cwd: fixture.root,
				sessionManager: {
					getSessionId: () => undefined,
					isPersisted: () => false,
				},
			} as unknown as Parameters<typeof handle>[2],
			{
				action: "create",
				title: "Builder",
				parent: parent.id,
				kind: "subquest",
			},
		);
		if (!child.ok) throw new Error(child.guidance);
		const calls: { cwd?: string }[] = [];
		registerTerminalDriver({
			id: "test",
			available: () => true,
			async spawn(req) {
				calls.push({ cwd: req.cwd });
			},
		});

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "spawn-tab",
			id: (child.details as { id: string }).id,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(calls[0]?.cwd).toBe(checkout);
		expect(result.message).toContain("(a parent quest's repo)");
		expect((result.details as { cwdSource?: string }).cwdSource).toBe(
			"ancestorRepoRoot",
		);
	});

	it("opens a quest with nowhere of its own in the spawner's repo", async () => {
		const state = buildState();
		const lone = await createQuest(state, "Lone");
		const repo = join(fixture.root, "repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		const calls: { cwd?: string }[] = [];
		registerTerminalDriver({
			id: "test",
			available: () => true,
			async spawn(req) {
				calls.push({ cwd: req.cwd });
			},
		});

		const result = await handle(state, fakePi(), fakeCtx(repo), {
			action: "spawn-tab",
			id: lone.id,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(calls[0]?.cwd).toBe(repo);
		expect((result.details as { cwdSource?: string }).cwdSource).toBe(
			"spawner",
		);
	});

	it("spawn-tab id:OTHER targets the other quest without mutating loaded state", async () => {
		joinSpawns("stage 1");
		const state = buildState();
		const loaded = await createQuest(state, "Loaded");
		const other = await createQuest(state, "Other");
		await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "load",
			id: loaded.id,
		});

		const calls: {
			cwd?: string;
			env?: Readonly<Record<string, string>>;
		}[] = [];
		registerTerminalDriver({
			id: "test",
			available: () => true,
			async spawn(req) {
				calls.push({ cwd: req.cwd, env: req.env });
			},
		});

		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "spawn-tab",
			id: other.id,
		});
		expect(result).toMatchObject({ ok: true });
		expect(calls[0]?.env).toEqual({
			QUEST_WORKFLOW_AUTOLOAD_ID: other.id,
			QUEST_WORKFLOW_FIRST_WORDS: expect.stringMatching(/^[0-9a-f-]{36}$/),
			PI_FENCE_STAGE: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		// The quest is named by the autoload, never by where it opens: a
		// session in a quest's folder loads no repo's skills.
		expect(at(calls, 0).cwd).not.toContain(state.questsRoot);
		// The caller's loaded state must not have changed.
		expect(state.questId).toBe(loaded.id);
	});

	it("spawn-tab refuses with a clean message when the id is unknown", async () => {
		const state = buildState();
		await createQuest(state, "Loaded");
		registerTerminalDriver({
			id: "test",
			available: () => true,
			async spawn() {
				/* not reached */
			},
		});
		const result = await handle(state, fakePi(), fakeCtx(fixture.root), {
			action: "spawn-tab",
			id: "QEST-29991231-MISSING",
		});
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error("unexpected ok");
		expect(result.guidance).toContain("No quest with id");
	});
});
