/**
 * What pi-sweep asks of its one sweep: the quests on disk for claims, git
 * held to the fence, what it took dropped from the quests that listed it,
 * and the providers its setting names loaded and named in its stamp.
 */

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { liveQuestTrees } from "../../extensions/quest-workflow/claims.ts";
import type { Exec } from "../../lib/core/exec/index.ts";
import { clearTreeProviders } from "../../lib/core/work/register.ts";
import type { SweepClaims } from "../../lib/core/work/sweep.ts";
import { sweepOutside } from "../../scripts/pi-sweep.ts";

const SPENT = "/src/repo/.worktrees/spent";

/** What the one sweep was given, and where the quests stand. */
const seen = vi.hoisted(() => ({
	quests: "",
	claims: [] as SweepClaims[],
	rests: [] as (number | undefined)[],
	execs: [] as Exec[],
}));

vi.mock("../../extensions/quest-workflow/config.ts", () => ({
	questsRootNow: async () => seen.quests,
}));

vi.mock("../../lib/core/work/sweep.ts", () => ({
	sweepEndedTrees: async (deps: {
		claims: () => SweepClaims;
		restMs?: number;
		exec: Exec;
	}) => {
		seen.claims.push(deps.claims());
		seen.rests.push(deps.restMs);
		seen.execs.push(deps.exec);
		return {
			taken: [{ path: SPENT, branch: "spent" }],
			refused: [],
			kept: [],
			dropped: [],
			branches: [],
		};
	},
}));

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-sweep-outside-"));
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
	seen.quests = join(root, "quests");
	seen.claims.length = 0;
	seen.rests.length = 0;
	seen.execs.length = 0;
});
afterEach(() => {
	clearTreeProviders();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/** One active quest on disk that lists `path`. */
function questListing(path: string): void {
	const id = "QEST-20260731-AAAAAA";
	mkdirSync(join(seen.quests, id), { recursive: true });
	writeFileSync(
		join(seen.quests, id, "README.md"),
		`---\nid: ${id}\nkind: quest\nstatus: active\npriority: active\n` +
			"rank: 1\nstarted: 2026-07-31\nupdated: 2026-07-31\n" +
			`trees:\n  - path: ${path}\n    providerId: git-worktree\n` +
			`    repoRoot: ${path}\n    origin: cut\n` +
			"---\n\n# Holding trees\n\n## Summary\n\nA quest with a tree.\n",
	);
}

/** The stamp the sweep left for the hosts, as it was written. */
function stamp(): unknown {
	const work = join(root, "state", "pi", "agentic-harness.pi", "work");
	return JSON.parse(readFileSync(join(work, "sweep.lock.outside"), "utf8"));
}

/** A module giving one provider that says whether its trees are spent. */
function providerModule(id: string): string {
	const path = join(root, `${id}.mjs`);
	writeFileSync(
		path,
		"export default () => [{\n" +
			`\tid: ${JSON.stringify(id)},\n` +
			"\tspecificity: 10,\n" +
			"\tappliesTo: () => false,\n" +
			'\tensure: async () => ({ path: "" }),\n' +
			"\trelease: async () => {},\n" +
			"\twhyKept: async () => undefined,\n" +
			"}];\n",
	);
	return path;
}

it("claims the quests' trees on disk, never rests, and drops what it took", async () => {
	questListing(SPENT);

	const end = await sweepOutside({});

	expect(end, "how the sweep ended").toBe("ran");
	expect(seen.claims, "the claims the sweep was given").toEqual([
		{ held: [], untilSpent: [SPENT] },
	]);
	expect(seen.rests, "the rest it was asked for").toEqual([undefined]);
	expect(
		liveQuestTrees(seen.quests),
		"the trees its quest still lists",
	).toEqual([]);
	expect(stamp(), "the stamp it left").toEqual({ judged: ["git-worktree"] });
});

it("holds its git to the fence in every repository", async () => {
	vi.stubEnv("PI_SANDBOX", "off");
	const repository = realpathSync(mkdtempSync(join(tmpdir(), "unguarded-")));
	execFileSync("git", ["init", "-q", repository]);
	try {
		await sweepOutside({});
		const said = await seen.execs[0]?.("git", ["-C", repository, "status"]);

		expect(said?.code, "git in a repository the fence doesn't guard").toBe(126);
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
});

it("loads the providers its setting names and names them in its stamp", async () => {
	const world = providerModule("world-dev-tree");

	await sweepOutside({ PI_SWEEP_PROVIDERS: world });

	expect(stamp(), "the stamp it left").toEqual({
		judged: ["git-worktree", "world-dev-tree"],
	});
});

it("passes over a provider module that won't load, naming none of its providers", async () => {
	const world = providerModule("world-dev-tree");
	const said = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	try {
		await sweepOutside({
			PI_SWEEP_PROVIDERS: `${join(root, "gone.mjs")}:${world}`,
		});

		expect(stamp(), "the stamp it left").toEqual({
			judged: ["git-worktree", "world-dev-tree"],
		});
		expect(String(said.mock.calls[0]?.[0]), "what it said").toContain(
			"pi-sweep: passed over",
		);
	} finally {
		said.mockRestore();
	}
});

it("fails before sweeping when git won't run, leaving the hosts sweeping", async () => {
	vi.stubEnv("PATH", join(root, "no-git"));

	const end = await sweepOutside({});

	expect(end, "how the sweep ended").toBe("failed");
	expect(seen.claims, "the sweeps it ran").toEqual([]);
	expect(() => stamp(), "the stamp it left").toThrow();
});
