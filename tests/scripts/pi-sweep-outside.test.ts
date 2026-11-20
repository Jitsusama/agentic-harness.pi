/**
 * What pi-sweep asks of its one sweep: the quests on disk for claims, git
 * held to the fence, what it took dropped from the quests that listed it,
 * the providers its setting names loaded and named in its stamp only once
 * they judged, and no sweep at all where its answers couldn't be trusted.
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
import type { TreeProvider } from "../../lib/core/work/broker.ts";
import { clearTreeProviders } from "../../lib/core/work/register.ts";
import type { SweepClaims } from "../../lib/core/work/sweep.ts";
import { sweepOutside } from "../../scripts/pi-sweep.ts";

const SPENT = "/src/repo/.worktrees/spent";

/** What the one sweep was given, and how the machine is steered. */
const seen = vi.hoisted(() => ({
	quests: "",
	unreadable: undefined as string | undefined,
	seesAll: true,
	claims: [] as SweepClaims[],
	rests: [] as (number | undefined)[],
	execs: [] as Exec[],
}));

vi.mock("../../extensions/quest-workflow/config.ts", () => ({
	questsRootNow: async () => {
		if (seen.unreadable !== undefined) throw new Error(seen.unreadable);
		return seen.quests;
	},
}));

vi.mock("../../extensions/work-integration/sweep.ts", async (original) => ({
	...(await original<object>()),
	seesEveryProcess: async () => seen.seesAll,
}));

vi.mock("../../lib/core/work/sweep.ts", () => ({
	sweepEndedTrees: async (deps: {
		claims: () => SweepClaims;
		restMs?: number;
		exec: Exec;
		providers: () => readonly TreeProvider[];
	}) => {
		seen.claims.push(deps.claims());
		seen.rests.push(deps.restMs);
		seen.execs.push(deps.exec);
		// As the library does: each provider that can is asked about a tree
		// of its own, and one that throws keeps it.
		for (const provider of deps.providers()) {
			await provider.whyKept?.({} as never).catch(() => undefined);
		}
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
	seen.unreadable = undefined;
	seen.seesAll = true;
	seen.claims.length = 0;
	seen.rests.length = 0;
	seen.execs.length = 0;
});
afterEach(() => {
	clearTreeProviders();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

/** The work state folder the sweep's lock, stamp and log go in. */
function work(): string {
	return join(root, "state", "pi", "agentic-harness.pi", "work");
}

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

/** The stamp the sweep left for the hosts, or nothing where it left none. */
function stamp(): unknown {
	try {
		return JSON.parse(readFileSync(join(work(), "sweep.lock.outside"), "utf8"));
	} catch {
		// No stamp, which is what several cases expect.
		return undefined;
	}
}

/** The sweep log's lines, each as the object it was written from. */
function logLines(): Record<string, unknown>[] {
	return readFileSync(join(work(), "sweep.log"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A provider's source, which says whether its trees are spent as `judge`. */
function providerSource(id: string, judge = "async () => undefined"): string {
	return (
		"{\n" +
		`\tid: ${JSON.stringify(id)},\n` +
		"\tspecificity: 10,\n" +
		"\tappliesTo: () => false,\n" +
		'\tensure: async () => ({ path: "" }),\n' +
		"\trelease: async () => {},\n" +
		`\twhyKept: ${judge},\n` +
		"}"
	);
}

/** A module whose default export is `give`, at a path of its own. */
function module(name: string, give: string): string {
	const path = join(root, `${name}.mjs`);
	writeFileSync(path, `export default ${give};\n`);
	return path;
}

it("claims the quests' trees on disk, never rests, and drops what it took", async () => {
	questListing(SPENT);

	const ran = await sweepOutside({ env: {} });

	expect(ran, "how the run ended").toEqual({ end: "ran", troubles: [] });
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
		await sweepOutside({ env: {} });
		const said = await seen.execs[0]?.("git", ["-C", repository, "status"]);

		expect(said?.code, "git in a repository the fence doesn't guard").toBe(126);
	} finally {
		rmSync(repository, { recursive: true, force: true });
	}
});

it("loads the providers its setting names and names them in its stamp", async () => {
	const world = module("world", `() => [${providerSource("world-dev-tree")}]`);

	const ran = await sweepOutside({ env: { PI_SWEEP_PROVIDERS: world } });

	expect(ran.troubles, "what went wrong beside").toEqual([]);
	expect(stamp(), "the stamp it left").toEqual({
		judged: ["git-worktree", "world-dev-tree"],
	});
});

it("leaves out of its stamp a provider that couldn't judge a tree", async () => {
	const world = module(
		"world",
		`() => [${providerSource(
			"world-dev-tree",
			'async () => { throw new Error("no dev here"); }',
		)}]`,
	);

	await sweepOutside({ env: { PI_SWEEP_PROVIDERS: world } });

	expect(stamp(), "the stamp it left").toEqual({ judged: ["git-worktree"] });
});

it("passes over a module whole when it gives anything but providers", async () => {
	const mixed = module(
		"mixed",
		`() => [${providerSource("world-dev-tree")}, { id: "junk" }]`,
	);
	vi.spyOn(process.stderr, "write").mockReturnValue(true);

	const ran = await sweepOutside({ env: { PI_SWEEP_PROVIDERS: mixed } });

	expect(ran.end, "how its sweep ended").toBe("ran");
	expect(ran.troubles, "what went wrong beside").toEqual([
		`${mixed}: it gave something that is no tree provider`,
	]);
	expect(stamp(), "the stamp it left").toEqual({ judged: ["git-worktree"] });
	expect(logLines()[0], "the line it logged first").toEqual(
		expect.objectContaining({ passedOver: ran.troubles }),
	);
});

it("passes over a module whose provider's judgement is no function", async () => {
	const garbled = module(
		"garbled",
		`() => [${providerSource("world-dev-tree", '"yes"')}]`,
	);
	vi.spyOn(process.stderr, "write").mockReturnValue(true);

	const ran = await sweepOutside({ env: { PI_SWEEP_PROVIDERS: garbled } });

	expect(ran.troubles, "what went wrong beside").toEqual([
		`${garbled}: it gave something that is no tree provider`,
	]);
	expect(stamp(), "the stamp it left").toEqual({ judged: ["git-worktree"] });
});

it("passes over a module that won't load, one named by a relative path, and one that never settles", async () => {
	const world = module("world", `() => [${providerSource("world-dev-tree")}]`);
	const stuck = module("stuck", "() => new Promise(() => {})");
	const said = vi.spyOn(process.stderr, "write").mockReturnValue(true);

	const ran = await sweepOutside({
		env: {
			PI_SWEEP_PROVIDERS: [
				join(root, "gone.mjs"),
				"world.mjs",
				stuck,
				world,
			].join(":"),
		},
		loadWithinMs: 50,
	});

	expect(
		ran.troubles.map((trouble) => trouble.split(": ")[0]),
		"the modules passed over",
	).toEqual([join(root, "gone.mjs"), "world.mjs", stuck]);
	expect(ran.troubles[1], "why the relative one was").toContain(
		"isn't an absolute path",
	);
	expect(ran.troubles[2], "why the one that never settled was").toContain(
		"gave nothing within 0.05 s",
	);
	expect(String(said.mock.calls[0]?.[0]), "what it said").toContain(
		"pi-sweep: passed over",
	);
	expect(stamp(), "the stamp it left").toEqual({
		judged: ["git-worktree", "world-dev-tree"],
	});
});

it("fails before sweeping when git won't run, leaving the hosts sweeping", async () => {
	vi.stubEnv("PATH", join(root, "no-git"));

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how the run ended").toBe("failed");
	expect(seen.claims, "the sweeps it ran").toEqual([]);
	expect(stamp(), "the stamp it left").toBeUndefined();
});

it("fails before sweeping when it can't see every process", async () => {
	seen.seesAll = false;

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how the run ended").toBe("failed");
	expect(seen.claims, "the sweeps it ran").toEqual([]);
	expect(logLines()[0]?.failed, "the line it logged").toBe(
		"it can't see every process on the machine",
	);
	expect(stamp(), "the stamp it left").toBeUndefined();
});

it("fails before sweeping when the config that says where the quests are won't load", async () => {
	seen.unreadable = "Could not parse package config";

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how the run ended").toBe("failed");
	expect(seen.claims, "the sweeps it ran").toEqual([]);
	expect(stamp(), "the stamp it left").toBeUndefined();
});

it("says a stamp it couldn't write", async () => {
	// A folder where the stamp goes, which no file can be renamed over.
	mkdirSync(join(work(), "sweep.lock.outside"), { recursive: true });

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how its sweep ended").toBe("ran");
	expect(ran.troubles, "what went wrong beside").toHaveLength(1);
	expect(logLines().at(-1), "the last line it logged").toHaveProperty(
		"unstamped",
	);
});
