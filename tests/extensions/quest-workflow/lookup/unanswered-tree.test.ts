/**
 * The quest tool when the quest folders give no answer in time: an
 * action that writes nothing answers from the last read, and one that
 * writes is refused, saying why, rather than either failing outright.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQuestState } from "../../../../extensions/quest-workflow/state.ts";
import { handle } from "../../../../extensions/quest-workflow/transitions.ts";
import {
	clearDiscoveryCache,
	readyQuests,
} from "../../../../lib/internal/quest/discovery/discovery.ts";
import { fakePi } from "../../../support/fake-pi.ts";
import { installTestHost } from "../../../support/session-host.ts";
import { createEnvGuard, fakeCtx } from "../_helpers.ts";

vi.mock(
	"../../../../lib/internal/quest/discovery/discovery.ts",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../../lib/internal/quest/discovery/discovery.ts")
			>();
		return { ...actual, readyQuests: vi.fn(actual.readyQuests) };
	},
);

const envGuard = createEnvGuard();
let tmpRoot: string;

beforeEach(() => {
	envGuard.enter();
	tmpRoot = mkdtempSync(join(tmpdir(), "unanswered-tree-"));
});

afterEach(() => {
	vi.mocked(readyQuests).mockReset();
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

/** The next ask of the tree, as a disk that won't answer leaves it. */
function nextReadUnanswered(): void {
	vi.mocked(readyQuests).mockRejectedValueOnce(
		new Error("the quest tree didn't answer a signing in time"),
	);
}

/** Two quests made through the tool, the second loaded. */
async function twoQuests() {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const ctx = fakeCtx(tmpRoot, "a");
	for (const title of ["Alpha", "Beta"]) {
		const made = await handle(state, fakePi(), ctx, {
			action: "create",
			title,
		});
		if (!made.ok) throw new Error(made.guidance);
	}
	return { state, ctx, readme: join(state.questDir ?? "", "README.md") };
}

it("lists from the last read when the quest folders don't answer", async () => {
	const { state, ctx } = await twoQuests();
	nextReadUnanswered();
	const listed = await handle(state, fakePi(), ctx, { action: "list" });

	expect(listed.ok ? "listed" : listed.guidance).toBe("listed");
});

it("refuses a write resting on other quests when the folders don't answer", async () => {
	const { state, ctx, readme } = await twoQuests();
	const before = readFileSync(readme, "utf8");
	nextReadUnanswered();
	const moved = await handle(state, fakePi(), ctx, {
		action: "bump",
	});

	expect(moved.ok ? "moved" : moved.guidance).toContain("didn't answer");
	expect(readFileSync(readme, "utf8")).toBe(before);
});

it("answers a dry run, which writes nothing, when the folders don't answer", async () => {
	const { state, ctx } = await twoQuests();
	nextReadUnanswered();
	const planned = await handle(state, fakePi(), ctx, {
		action: "reparent",
		parent: "null",
		dryRun: true,
	});

	expect(planned.ok ? "planned" : planned.guidance).not.toContain(
		"didn't answer",
	);
});

it("expands from the last read when the folders don't answer", async () => {
	const { state, ctx } = await twoQuests();
	nextReadUnanswered();
	const expanded = await handle(state, fakePi(), ctx, { action: "expand" });

	expect(expanded.ok ? "expanded" : expanded.guidance).not.toContain(
		"didn't answer",
	);
});

it("says what an unknown action might mean, whatever the folders say", async () => {
	const { state, ctx } = await twoQuests();
	nextReadUnanswered();
	const typo = await handle(state, fakePi(), ctx, {
		action: "lsit" as "list",
	});

	expect(typo.ok ? "answered" : typo.guidance).toContain("list");
	expect(typo.ok ? "answered" : typo.guidance).not.toContain("didn't answer");
	vi.mocked(readyQuests).mockReset();
});

it("on a host, reads nothing on the thread for folders that never answered a read", async () => {
	const host = installTestHost();
	try {
		clearDiscoveryCache();
		const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
		nextReadUnanswered();
		const listed = await handle(state, fakePi(), fakeCtx(tmpRoot, "a"), {
			action: "list",
		});

		expect(listed.ok ? "listed" : listed.guidance).toContain(
			"haven't answered a first read",
		);
	} finally {
		host.dispose();
		clearDiscoveryCache();
	}
});
