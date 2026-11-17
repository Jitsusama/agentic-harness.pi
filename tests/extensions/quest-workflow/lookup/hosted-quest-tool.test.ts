/**
 * The quest tool on a host, whose discovery answers a known tree from
 * its last walk for a few seconds: each action signs the tree first, so
 * what it reads and decides on is the tree as it stands.
 */

import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import { withSession } from "../../../../lib/core/session/index.ts";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../../../lib/internal/quest/discovery/discovery.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { installTestHost } from "../../../support/session-host.ts";
import { createEnvGuard, fakeCtx } from "../_helpers.ts";

const envGuard = createEnvGuard();
let tmpRoot: string;
let host: ReturnType<typeof installTestHost>;

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "hosted-quest-tool-"));
	clearDiscoveryCache();
	host = installTestHost();
});

afterEach(() => {
	host.dispose();
	clearDiscoveryCache();
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

/** Date everything under `path` well before now, as a settled tree is. */
function settleAll(path: string): void {
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const inner = join(path, entry.name);
		if (entry.isDirectory()) settleAll(inner);
		else settle(inner);
	}
	settle(path);
}

function settle(path: string): void {
	const past = new Date(Date.now() - 60_000);
	utimesSync(path, past, past);
}

it("reads the tree as it stands at each action, not the host's last walk", async () => {
	const questsRoot = join(tmpRoot, "quests");
	const state = createQuestState({ questsRoot });
	const ctx = fakeCtx(tmpRoot, "a");
	const created = await withSession("a", () =>
		handle(state, fakePi(), ctx, { action: "create", title: "Alpha" }),
	);
	if (!created.ok) throw new Error(created.guidance);
	const id = state.questId ?? "";
	const readmePath = join(state.questDir ?? "", "README.md");
	settleAll(questsRoot);
	expect([...discoverQuests(questsRoot).index.quests.keys()]).toContain(id);

	const text = readFileSync(readmePath, "utf8");
	writeFileSync(readmePath, text.replace(/^status: \w+$/m, "status: paused"));
	settle(readmePath);
	await withSession("a", () =>
		handle(state, fakePi(), ctx, { action: "list" }),
	);

	expect(
		discoverQuests(questsRoot).index.quests.get(id)?.doc.frontMatter.status,
	).toBe("paused");
});
