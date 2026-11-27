/**
 * A host forgetting swept trees when its disk gives no answer: a store
 * it never walked is skipped rather than signed whole on the thread
 * every conversation shares. Its own file, since it stands discovery's
 * signing in for one that always fails.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetTrees } from "../../../../extensions/quest-workflow/claims.ts";
import * as discovery from "../../../../lib/internal/quest/discovery/discovery.ts";
import { installTestHost } from "../../../support/session-host.ts";

vi.mock(
	"../../../../lib/internal/quest/discovery/discovery.ts",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("../../../../lib/internal/quest/discovery/discovery.ts")
			>();
		return {
			...real,
			discoverQuestsAfresh: vi.fn(() =>
				Promise.reject(new Error("the disk gave no answer")),
			),
			discoverQuests: vi.fn(real.discoverQuests),
		};
	},
);

const ID = "QEST-20260731-AAAAAA";
const SPENT = "/src/repo/.worktrees/spent";

let root: string;
let host: ReturnType<typeof installTestHost>;

beforeEach(() => {
	discovery.clearDiscoveryCache();
	host = installTestHost();
	root = mkdtempSync(join(tmpdir(), "swept-unwalked-"));
	mkdirSync(join(root, ID));
	writeFileSync(
		join(root, ID, "README.md"),
		`---\nid: ${ID}\nkind: quest\nstatus: active\npriority: active\n` +
			"rank: 1\nstarted: 2026-07-31\nupdated: 2026-07-31\n" +
			`trees:\n  - path: ${SPENT}\n    providerId: git-worktree\n` +
			`    repoRoot: ${SPENT}\n    origin: scaffolded\n` +
			"---\n\n# Holding trees\n\n## Summary\n\nA quest with a tree.\n",
	);
	vi.mocked(discovery.discoverQuests).mockClear();
	vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
	vi.restoreAllMocks();
	host.dispose();
	discovery.clearDiscoveryCache();
	rmSync(root, { recursive: true, force: true });
});

/** The roots discovery was asked to answer from its last walk. */
function answeredFromLastWalk(): string[] {
	return vi.mocked(discovery.discoverQuests).mock.calls.map(([asked]) => asked);
}

describe("forgetting swept trees on a host whose disk gives no answer", () => {
	it("skips a store it never walked rather than sign it on the thread", async () => {
		await forgetTrees(root, [SPENT]);
		expect(answeredFromLastWalk()).not.toContain(root);
	});

	it("answers a store it walked from that walk", async () => {
		vi.mocked(discovery.discoverQuests).getMockImplementation()?.(root);
		vi.mocked(discovery.discoverQuests).mockClear();
		await forgetTrees(root, [SPENT]);
		expect(answeredFromLastWalk()).toContain(root);
	});
});
