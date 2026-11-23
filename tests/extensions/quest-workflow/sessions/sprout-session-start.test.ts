/**
 * A sprout driven through session_start as pi runs it: the order of its
 * halves keeps the node's prose unsaid, the sprout's own words said once,
 * and the session on the quest it made.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BudgetKeeper } from "../../../../extensions/quest-workflow/budget.ts";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { followSessionLife } from "../../../../extensions/quest-workflow/wiring/session.ts";
import { withSession } from "../../../../lib/core/session/index.ts";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../../../lib/internal/quest/discovery/discovery.ts";
import { runStarted } from "../../../../lib/internal/session/first-prompt.ts";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
} from "../../../../lib/refs/index.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { createEnvGuard } from "../_helpers.ts";

const SEED = "QUEST_WORKFLOW_SPROUT";
const PROSE = "QUEST_WORKFLOW_FIRST_TEXT";
const SESSION = "sess-sprouted";

const envGuard = createEnvGuard();
let tmpRoot: string;
let savedHome: string | undefined;
/**
 * The session's own ties, which would reach its live mesh, host and node,
 * and the state folder, which would reach the live launcher's quest lists;
 * without it they fall under HOME, here the test's own folder. A switch
 * the suite set off (PI_NOTIFY, PI_LAUNCHER, PI_SESSIONS_KITTY,
 * PI_SETTLE) stays, since deleting it turns its reach to the desktop on.
 */
const TIES = /^(PI_|MYCELIUM_|XDG_STATE_HOME$)/u;
let savedTies: [string, string][] = [];

beforeEach(() => {
	registerBuiltinRefTypes();
	envGuard.enter();
	savedTies = Object.entries(process.env).flatMap(([name, value]) =>
		TIES.test(name) && value !== undefined && value !== "off"
			? [[name, value] as [string, string]]
			: [],
	);
	for (const [name] of savedTies) delete process.env[name];
	tmpRoot = mkdtempSync(join(tmpdir(), "sprout-session-start-"));
	savedHome = process.env.HOME;
	process.env.HOME = tmpRoot;
	clearDiscoveryCache();
	// No first prompt waits, so the start's words go out when asked.
	runStarted();
});

afterEach(() => {
	if (savedHome !== undefined) process.env.HOME = savedHome;
	else delete process.env.HOME;
	delete process.env[SEED];
	delete process.env[PROSE];
	clearDiscoveryCache();
	for (const [name, value] of savedTies) process.env[name] = value;
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
	clearRefTypes();
});

/** A fresh session's context at its start, with nothing to restore. */
function startIn(cwd: string): unknown {
	return {
		cwd,
		hasUI: false,
		isIdle: () => true,
		ui: new Proxy({}, { get: () => () => undefined }),
		sessionManager: {
			getSessionId: () => SESSION,
			isPersisted: () => true,
			getEntries: () => [],
			getBranch: () => [],
		},
	};
}

it("says the sprout's words once, never the node's prose, and leaves the session on its quest", async () => {
	process.env[SEED] = JSON.stringify({ v: 1, words: "the work", id: "S90" });
	process.env[PROSE] = "the node's prose";
	const pi = fakePi();
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const budgets = { keep: async () => undefined, forget: () => undefined };
	followSessionLife(pi, state, budgets as unknown as BudgetKeeper, undefined);
	const [start] = pi.recorded.handlers.get("session_start") ?? [];
	const [discover] = pi.recorded.handlers.get("resources_discover") ?? [];
	const ctx = startIn(tmpRoot);
	await withSession(SESSION, async () => {
		await start?.({ type: "session_start", reason: "startup" }, ctx);
		await discover?.({ type: "resources_discover" }, ctx);
	});

	await vi.waitFor(() => expect(pi.recorded.sentAsUser).toHaveLength(1));
	// A second send, the node's prose after the sprout's words, would come
	// on a later tick; give it one before counting.
	await new Promise((settle) => setTimeout(settle, 50));
	expect(pi.recorded.sentAsUser, "said once").toHaveLength(1);
	const said = String(pi.recorded.sentAsUser[0]);
	expect(said).toMatch(/is made and loaded for it/u);
	expect(said).not.toContain("the node's prose");
	const made = state.questId;
	if (!made) throw new Error("the sprout loaded no quest");
	expect(said).toContain(made);
	clearDiscoveryCache();
	const dir = discoverQuests(join(tmpRoot, "quests")).index.quests.get(
		made,
	)?.dir;
	if (!dir) throw new Error(`no folder for ${made}`);
	const readme = readFileSync(join(dir, "README.md"), "utf8");
	expect(readme, "the session is on the quest it made").toContain(SESSION);
});
