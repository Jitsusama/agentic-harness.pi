/**
 * What pi-sweep asks of its one sweep: the quests on disk for claims, git
 * held to the fence, what it took dropped from the quests that listed it,
 * the providers its setting names loaded and named in its stamp only once
 * they judged, and no sweep at all where its answers couldn't be trusted.
 *
 * Long because every case drives the one run through the same mocked
 * sweep and quest store, hoisted for the whole file, which a second file
 * would have to copy and keep in step.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { liveQuestTrees } from "../../extensions/quest-workflow/claims.ts";
import type { SweepEnd } from "../../extensions/work-integration/sweep.ts";
import type { Exec } from "../../lib/core/exec/index.ts";
import type { TreeProvider } from "../../lib/core/work/broker.ts";
import { clearTreeProviders } from "../../lib/core/work/register.ts";
import type { SweepClaims } from "../../lib/core/work/sweep.ts";
import { IDLE_TAKES_PER_SWEEP } from "../../lib/core/work/sweep-idle.ts";
import { cutTreeDir } from "../../lib/internal/work-records.ts";
import { exitCodeOf, sweepOutside } from "../../scripts/pi-sweep.ts";

const SPENT = "/src/repo/.worktrees/spent";

/** What the one sweep was given, and how the machine is steered. */
const seen = vi.hoisted(() => ({
	quests: "",
	unreadable: undefined as string | undefined,
	seesAll: true,
	listsFirst: true,
	releasing: false,
	trees: 1,
	partly: undefined as string | undefined,
	left: undefined as number | undefined,
	idleMs: undefined as number | undefined,
	fails: undefined as string | undefined,
	claims: [] as SweepClaims[],
	rests: [] as (number | undefined)[],
	idleTakes: [] as (number | undefined)[],
	idleWithin: [] as (number | undefined)[],
	betweenIdleTakes: [] as (undefined | (() => Promise<void>))[],
	treesDirs: [] as (string | undefined)[],
	execs: [] as Exec[],
	lockWaits: [] as (number | undefined)[],
	listsMerged: [] as boolean[],
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
	listsFirstProcess: async () => seen.listsFirst,
}));

vi.mock("../../lib/core/work/sweep.ts", () => ({
	sweepEndedTrees: async (deps: {
		claims: () => SweepClaims;
		restMs?: number;
		idleTakes?: number;
		idleWithinMs?: number;
		betweenIdleTakes?: () => Promise<void>;
		treesDir?: string;
		exec: Exec;
		providers: () => readonly TreeProvider[];
		lockWaitMs?: number;
		mergedHeads?: unknown;
	}) => {
		seen.lockWaits.push(deps.lockWaitMs);
		seen.listsMerged.push(deps.mergedHeads !== undefined);
		seen.claims.push(deps.claims());
		seen.rests.push(deps.restMs);
		seen.idleTakes.push(deps.idleTakes);
		seen.idleWithin.push(deps.idleWithinMs);
		seen.betweenIdleTakes.push(deps.betweenIdleTakes);
		seen.treesDirs.push(deps.treesDir);
		seen.execs.push(deps.exec);
		if (seen.fails !== undefined) throw new Error(seen.fails);
		// As the library does: each provider that can is asked about a tree
		// of its own, and one that throws keeps it.
		for (const provider of deps.providers()) {
			for (let tree = 0; tree < seen.trees; tree++) {
				await provider.whyKept?.({} as never).catch(() => undefined);
				if (seen.releasing) {
					await provider.release({} as never).catch(() => undefined);
				}
			}
		}
		return {
			taken: [{ path: SPENT, branch: "spent" }],
			refused: [],
			kept: [],
			dropped: [],
			branches: [],
			...(seen.partly === undefined ? {} : { idleUnjudged: seen.partly }),
			...(seen.left === undefined ? {} : { idleLeft: seen.left }),
			...(seen.idleMs === undefined ? {} : { idleMs: seen.idleMs }),
		};
	},
}));

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-sweep-outside-"));
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
	// The quests' scratch is its own, as a session's TMPDIR may lie in the
	// real one, and a module there would be passed over.
	vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
	seen.quests = join(root, "quests");
	mkdirSync(seen.quests);
	seen.unreadable = undefined;
	seen.seesAll = true;
	seen.listsFirst = true;
	seen.releasing = false;
	seen.trees = 1;
	seen.partly = undefined;
	seen.left = undefined;
	seen.idleMs = undefined;
	seen.fails = undefined;
	seen.claims.length = 0;
	seen.rests.length = 0;
	seen.idleTakes.length = 0;
	seen.idleWithin.length = 0;
	seen.betweenIdleTakes.length = 0;
	seen.treesDirs.length = 0;
	seen.execs.length = 0;
	seen.lockWaits.length = 0;
	seen.listsMerged.length = 0;
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

/** The quests store another realm, `work`, keeps on this machine. */
function otherRealmsQuests(): string {
	return join(
		root,
		"data",
		"pi",
		"agentic-harness.pi",
		"realms",
		"work",
		"quest-workflow",
		"quests",
	);
}

/** One quest on disk in `store`, active unless said, that lists `path`. */
function questListing(
	path: string,
	{
		store = seen.quests,
		id = "QEST-20260731-AAAAAA",
		status = "active",
	}: { store?: string; id?: string; status?: string } = {},
): void {
	mkdirSync(join(store, id), { recursive: true });
	writeFileSync(
		join(store, id, "README.md"),
		`---\nid: ${id}\nkind: quest\nstatus: ${status}\npriority: active\n` +
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

/**
 * A provider's source, which says whether its trees are spent as `judge`
 * and takes one as `take`.
 */
function providerSource(
	id: string,
	judge = "async () => undefined",
	take = "async () => {}",
): string {
	return (
		"{\n" +
		`\tid: ${JSON.stringify(id)},\n` +
		"\tspecificity: 10,\n" +
		"\tappliesTo: () => false,\n" +
		'\tensure: async () => ({ path: "" }),\n' +
		`\trelease: ${take},\n` +
		`\twhyKept: ${judge},\n` +
		"}"
	);
}

/**
 * A module whose default export is `give`, at a path of its own, with
 * node:fs as `fs` loaded with it, so no call waits on an import inside
 * a clock that times it.
 */
function module(name: string, give: string): string {
	const path = join(root, `${name}.mjs`);
	writeFileSync(
		path,
		`import * as fs from "node:fs";\nexport default ${give};\n`,
	);
	return path;
}

it("claims the quests' trees on disk, never rests, takes more idle snapshots than a host for a bounded time, and drops what it took", async () => {
	questListing(SPENT);

	const ran = await sweepOutside({ env: {} });

	expect(ran, "how the run ended").toEqual({ end: "ran", troubles: [] });
	expect(seen.claims, "the claims the sweep was given").toEqual([
		{ held: [], untilSpent: [SPENT] },
	]);
	expect(seen.rests, "the rest it was asked for").toEqual([undefined]);
	expect(
		seen.idleTakes[0],
		"idle snapshots it may take, past a host's few, as it holds no host's thread",
	).toBeGreaterThan(IDLE_TAKES_PER_SWEEP);
	// At least a minute, as milliseconds, and less than the hour between
	// runs, so it neither ends at once nor runs into the next.
	expect(
		seen.idleWithin[0],
		"how long it may judge them for, so a loaded machine gets fewer",
	).toBeGreaterThanOrEqual(60 * 1000);
	expect(seen.idleWithin[0]).toBeLessThan(60 * 60 * 1000);
	// Minutes behind a host's sweep, yet well inside the unit's two hours.
	expect(
		seen.lockWaits[0],
		"how long it waits its turn for the lock",
	).toBeGreaterThanOrEqual(5 * 60 * 1000);
	expect(seen.lockWaits[0]).toBeLessThan(2 * 60 * 60 * 1000);
	expect(
		seen.listsMerged,
		"it alone lists the pull requests merged into trunk",
	).toEqual([true]);
	expect(
		seen.treesDirs[0],
		"where it finishes removals stopped part way, as it paces them: the broker's own trees",
	).toBe(cutTreeDir());
	// A gap of a second or more between removals, yet short enough that a
	// run's ten minutes still hold many takes.
	vi.useFakeTimers();
	try {
		let paused = true;
		const pausing = seen.betweenIdleTakes[0]?.().then(() => {
			paused = false;
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(paused, "done pausing within a second").toBe(true);
		await vi.advanceTimersByTimeAsync(4001);
		expect(paused, "still pausing after five seconds").toBe(false);
		await pausing;
	} finally {
		vi.useRealTimers();
	}
	expect(
		liveQuestTrees(seen.quests),
		"the trees its quest still lists",
	).toEqual([]);
	expect(stamp(), "the stamp it left").toEqual({ judged: ["git-worktree"] });
});

it("claims the trees another realm's live quests list, and no sealed one's", async () => {
	const sealed = "/src/repo/.worktrees/sealed";
	questListing(SPENT, { store: otherRealmsQuests() });
	questListing(sealed, {
		store: otherRealmsQuests(),
		id: "QEST-20260731-BBBBBB",
		status: "concluded",
	});

	await sweepOutside({ env: {} });

	expect(seen.claims, "the claims the sweep was given").toEqual([
		{ held: [], untilSpent: [SPENT] },
	]);
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
	const said = vi.spyOn(process.stderr, "write").mockReturnValue(true);

	const ran = await sweepOutside({ env: { PI_SWEEP_PROVIDERS: world } });

	expect(stamp(), "the stamp it left").toEqual({ judged: ["git-worktree"] });
	expect(ran.troubles, "what went wrong beside").toEqual([
		"world-dev-tree couldn't judge or take every tree",
	]);
	expect(exitCodeOf(ran), "the code it exits with").toBe(1);
	expect(
		said.mock.calls.map((call) => String(call[0])),
		"what its unit's journal was told",
	).toContain(
		"pi-sweep: world-dev-tree couldn't judge or take every tree, so the hosts sweep its trees; sweep.log counts the commonest reasons kept and names each tree refused\n",
	);
});

it("asks a provider that hung nothing more that run", async () => {
	seen.trees = 3;
	const asked = join(root, "asked");
	const world = module(
		"world",
		`() => [${providerSource(
			"world-dev-tree",
			`async () => { fs.appendFileSync(${JSON.stringify(asked)}, "x"); return new Promise(() => {}); }`,
		)}]`,
	);

	await sweepOutside({ env: { PI_SWEEP_PROVIDERS: world }, callWithinMs: 50 });

	expect(readFileSync(asked, "utf8"), "each time it was asked").toBe("x");
});

it("asks a provider that threw for one tree about the rest, and stamps it", async () => {
	seen.trees = 3;
	const asked = join(root, "asked");
	const world = module(
		"world",
		`() => [${providerSource(
			"world-dev-tree",
			`async () => { const first = !fs.existsSync(${JSON.stringify(asked)}); fs.appendFileSync(${JSON.stringify(asked)}, "x"); if (first) throw new Error("one bad tree"); }`,
		)}]`,
	);

	const ran = await sweepOutside({ env: { PI_SWEEP_PROVIDERS: world } });

	expect(readFileSync(asked, "utf8"), "each time it was asked").toBe("xxx");
	expect(stamp(), "the stamp it left").toEqual({
		judged: ["git-worktree", "world-dev-tree"],
	});
	expect(ran.troubles, "what went wrong beside").toEqual([
		"world-dev-tree couldn't judge or take every tree",
	]);
	expect(exitCodeOf(ran), "the code it exits with").toBe(1);
});

it("stamps a provider that couldn't take one tree but took another", async () => {
	seen.releasing = true;
	seen.trees = 2;
	const took = join(root, "took");
	const world = module(
		"world",
		`() => [${providerSource(
			"world-dev-tree",
			undefined,
			`async () => { const first = !fs.existsSync(${JSON.stringify(took)}); fs.appendFileSync(${JSON.stringify(took)}, "x"); if (first) throw new Error("dev refused"); }`,
		)}]`,
	);

	const ran = await sweepOutside({ env: { PI_SWEEP_PROVIDERS: world } });

	expect(stamp(), "the stamp it left").toEqual({
		judged: ["git-worktree", "world-dev-tree"],
	});
	expect(exitCodeOf(ran), "the code it exits with").toBe(1);
});

it("leaves out of its stamp a provider that judged a tree but took none", async () => {
	seen.releasing = true;
	seen.trees = 2;
	const asked = join(root, "asked");
	const world = module(
		"world",
		`() => [${providerSource(
			"world-dev-tree",
			`async () => { const first = !fs.existsSync(${JSON.stringify(asked)}); fs.appendFileSync(${JSON.stringify(asked)}, "x"); if (first) throw new Error("one bad tree"); }`,
			'async () => { throw new Error("dev is gone"); }',
		)}]`,
	);

	const ran = await sweepOutside({ env: { PI_SWEEP_PROVIDERS: world } });

	expect(stamp(), "the stamp it left").toEqual({ judged: ["git-worktree"] });
	expect(exitCodeOf(ran), "the code it exits with").toBe(1);
});

it("puts no clock on taking a tree", async () => {
	seen.releasing = true;
	const world = module(
		"world",
		`() => [${providerSource(
			"world-dev-tree",
			undefined,
			// A take that outlasts the judging clock below, as dev's removal
			// of a large tree can.
			"() => new Promise((done) => setTimeout(done, 200))",
		)}]`,
	);

	const ran = await sweepOutside({
		env: { PI_SWEEP_PROVIDERS: world },
		callWithinMs: 20,
	});

	expect(ran.troubles, "what went wrong beside").toEqual([]);
	expect(stamp(), "the stamp it left").toEqual({
		judged: ["git-worktree", "world-dev-tree"],
	});
});

it("leaves out of its stamp a provider that couldn't take a tree", async () => {
	seen.releasing = true;
	const world = module(
		"world",
		`() => [${providerSource(
			"world-dev-tree",
			undefined,
			'async () => { throw new Error("dev is gone"); }',
		)}]`,
	);
	const said = vi.spyOn(process.stderr, "write").mockReturnValue(true);

	const ran = await sweepOutside({ env: { PI_SWEEP_PROVIDERS: world } });

	expect(stamp(), "the stamp it left").toEqual({ judged: ["git-worktree"] });
	expect(exitCodeOf(ran), "the code it exits with").toBe(1);
	// A failed take is logged under refused, by its tree, not as a reason kept.
	expect(
		said.mock.calls.map((call) => String(call[0])),
		"what its unit's journal was told",
	).toContain(
		"pi-sweep: world-dev-tree couldn't judge or take every tree, so the hosts sweep its trees; sweep.log counts the commonest reasons kept and names each tree refused\n",
	);
});

it("stops and leaves out of its stamp a provider whose judgement never settles", async () => {
	const stopped = join(root, "stopped");
	const world = module(
		"world",
		`() => [${providerSource(
			"world-dev-tree",
			`async (_held, options) => { options.signal.addEventListener("abort", () => fs.writeFileSync(${JSON.stringify(stopped)}, "")); return new Promise(() => {}); }`,
		)}]`,
	);

	const ran = await sweepOutside({
		env: { PI_SWEEP_PROVIDERS: world },
		callWithinMs: 50,
	});

	expect(ran.end, "how its sweep ended").toBe("ran");
	expect(stamp(), "the stamp it left").toEqual({ judged: ["git-worktree"] });
	expect(existsSync(stopped), "whether it was told to stop").toBe(true);
});

it("passes over a module whose provider's judgement is null", async () => {
	const world = module(
		"world",
		`() => [${providerSource("world-dev-tree", "null")}]`,
	);
	vi.spyOn(process.stderr, "write").mockReturnValue(true);

	const ran = await sweepOutside({ env: { PI_SWEEP_PROVIDERS: world } });

	expect(ran.troubles, "what went wrong beside").toEqual([
		`${world}: it gave something that is no tree provider`,
	]);
	expect(stamp(), "the stamp it left").toEqual({ judged: ["git-worktree"] });
});

it("logs how many idle snapshots its time left, and how long their phase took, as a run that ran", async () => {
	// Its time stops only what lies past a host's share, so the hosts may
	// stand down as after any run that judged everything it was given. The
	// phase's own time tells a slow run's idle takes from what came before.
	seen.left = 3;
	seen.idleMs = 1234;

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how its sweep ended").toBe("ran");
	expect(exitCodeOf(ran), "the code the run exits with").toBe(0);
	expect(stamp(), "the stamp it left").toEqual({ judged: ["git-worktree"] });
	expect(logLines()[0], "the line it logged").toEqual(
		expect.objectContaining({ idleLeft: 3, idleMs: 1234 }),
	);
});

it("leaves no stamp after a sweep that left idle snapshots unjudged", async () => {
	seen.partly = "the snapshots can't be listed";
	const said = vi.spyOn(process.stderr, "write").mockReturnValue(true);

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how its sweep ended").toBe("partly");
	expect(stamp(), "the stamp it left").toBeUndefined();
	expect(exitCodeOf(ran), "the code the run exits with").toBe(1);
	expect(
		said.mock.calls.map(([line]) => String(line)),
		"what it said",
	).toEqual([
		"pi-sweep: sweep left idle snapshots unjudged: the snapshots can't be listed\n",
	]);
});

it("says in its journal why its sweep failed", async () => {
	seen.fails = "the records can't be read";
	const said = vi.spyOn(process.stderr, "write").mockReturnValue(true);

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how its sweep ended").toBe("failed");
	expect(stamp(), "the stamp it left").toBeUndefined();
	expect(exitCodeOf(ran), "the code the run exits with").toBe(1);
	expect(
		said.mock.calls.map(([line]) => String(line)),
		"what it said",
	).toEqual(["pi-sweep: sweep failed: the records can't be read\n"]);
});

it("exits 0 only after a sweep that ran or met another's, with no trouble beside", () => {
	const code = (end: SweepEnd, troubles: string[] = []) =>
		exitCodeOf({ end, troubles });

	expect(
		{
			ran: code("ran"),
			skipped: code("skipped"),
			rested: code("rested"),
			partly: code("partly"),
			failed: code("failed"),
			troubled: code("ran", ["gone.mjs: no such file"]),
		},
		"the code each run exits with",
	).toEqual({
		ran: 0,
		skipped: 0,
		rested: 0,
		partly: 1,
		failed: 1,
		troubled: 1,
	});
});

it.each([
	["a work tree", () => join(work(), "trees", "someone")],
	[
		"a quest's scratch",
		() =>
			join(root, "cache", "pi", "agentic-harness.pi", "quest-workspace", "Q"),
	],
])(
	"passes over a module in %s, where a sandboxed command writes",
	async (_, folder) => {
		const planted = join(folder(), "providers.mjs");
		mkdirSync(folder(), { recursive: true });
		writeFileSync(
			planted,
			`export default () => [${providerSource("world-dev-tree")}];\n`,
		);
		vi.spyOn(process.stderr, "write").mockReturnValue(true);

		const ran = await sweepOutside({ env: { PI_SWEEP_PROVIDERS: planted } });

		expect(ran.troubles, "what went wrong beside").toEqual([
			`${planted}: it sits where a sandboxed command can write, and it would run outside the fence`,
		]);
		expect(stamp(), "the stamp it left").toEqual({ judged: ["git-worktree"] });
	},
);

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
		// Long enough that the module that loads is never cut off, however
		// busy the machine, and short for the one that never settles.
		loadWithinMs: 1000,
	});

	expect(
		ran.troubles.map((trouble) => trouble.split(": ")[0]),
		"the modules passed over",
	).toEqual([join(root, "gone.mjs"), "world.mjs", stuck]);
	expect(ran.troubles[1], "why the relative one was").toContain(
		"isn't an absolute path",
	);
	expect(ran.troubles[2], "why the one that never settled was").toContain(
		"gave nothing within 1 s",
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

it("fails before sweeping when /proc hides the machine's first process", async () => {
	seen.listsFirst = false;
	vi.spyOn(process.stderr, "write").mockReturnValue(true);

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

it("fails before sweeping when the quests aren't where the config says", async () => {
	rmSync(seen.quests, { recursive: true });

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how the run ended").toBe("failed");
	expect(seen.claims, "the sweeps it ran").toEqual([]);
	expect(logLines()[0]?.failed, "the line it logged").toBe(
		`the quests aren't at ${seen.quests}`,
	);
	expect(stamp(), "the stamp it left").toBeUndefined();
});

it("fails before sweeping when the quests can't be looked at", async () => {
	const locked = join(root, "locked");
	mkdirSync(join(locked, "quests"), { recursive: true });
	seen.quests = join(locked, "quests");
	chmodSync(locked, 0o000);
	try {
		const ran = await sweepOutside({ env: {} });

		expect(ran.end, "how the run ended").toBe("failed");
		expect(seen.claims, "the sweeps it ran").toEqual([]);
		expect(String(logLines()[0]?.failed), "the line it logged").toContain(
			"can't be looked at",
		);
	} finally {
		chmodSync(locked, 0o700);
	}
});

it("fails before sweeping when another realm's quests can't be listed", async () => {
	// Its trees are the machine's, so a store read as empty would have the
	// sweep take them as nobody's.
	const realm = otherRealmsQuests();
	mkdirSync(realm, { recursive: true });
	chmodSync(realm, 0o000);
	try {
		const ran = await sweepOutside({ env: {} });

		expect(ran.end, "how the run ended").toBe("failed");
		expect(seen.claims, "the sweeps it ran").toEqual([]);
		expect(String(logLines()[0]?.failed), "the line it logged").toContain(
			`the quests at ${realm} can't be looked at`,
		);
		expect(stamp(), "the stamp it left").toBeUndefined();
	} finally {
		chmodSync(realm, 0o700);
	}
});

it("fails before sweeping when a quest can't be read for its claims", async () => {
	// The walk leaves such a quest out, so the trees it lists would go.
	questListing(SPENT);
	const quest = join(seen.quests, "QEST-20260731-AAAAAA");
	chmodSync(quest, 0o000);
	try {
		const ran = await sweepOutside({ env: {} });

		expect(ran.end, "how the run ended").toBe("failed");
		expect(seen.claims, "the sweeps it ran").toEqual([]);
		expect(String(logLines()[0]?.failed), "the line it logged").toContain(
			`the quest at ${quest} can't be read for its claims`,
		);
	} finally {
		chmodSync(quest, 0o700);
	}
});

it("fails before sweeping when a quest's README won't parse", async () => {
	// Its front matter may list any tree, and none of them can be read.
	const quest = join(seen.quests, "QEST-20260731-AAAAAA");
	mkdirSync(quest);
	writeFileSync(
		join(quest, "README.md"),
		"# A quest whose front matter went\n",
	);
	const told = vi.spyOn(process.stderr, "write").mockReturnValue(true);

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how the run ended").toBe("failed");
	expect(seen.claims, "the sweeps it ran").toEqual([]);
	expect(String(logLines()[0]?.failed), "the line it logged").toContain(
		`the quest at ${quest} can't be read for its claims: Front-matter invalid`,
	);
	// The hosts take sweeping back, but miss the same quest's claims.
	expect(told.mock.calls.join(""), "what it told the journal").toContain(
		"the hosts sweep again once the last stamp is 2 hours old, and their claims miss the same quests",
	);
});

it("sweeps past a quest named apart from its id, and ones still being made", async () => {
	// The first is still read for its claims; the others list no trees.
	questListing(SPENT);
	renameSync(
		join(seen.quests, "QEST-20260731-AAAAAA"),
		join(seen.quests, "QEST-20260731-BBBBBB"),
	);
	mkdirSync(join(seen.quests, "QEST-20260731-CCCCCC"));
	mkdirSync(join(seen.quests, "QEST-20260731-DDDDDD"));
	writeFileSync(join(seen.quests, "QEST-20260731-DDDDDD", "README.md"), "");

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how the run ended").not.toBe("failed");
	expect(seen.claims, "the claims the sweep was given").toEqual([
		{ held: [], untilSpent: [SPENT] },
	]);
});

it("fails before sweeping when the realms can't be listed", async () => {
	// A realms folder read as empty hides every other realm's quests.
	const realms = join(otherRealmsQuests(), "..", "..", "..");
	mkdirSync(otherRealmsQuests(), { recursive: true });
	chmodSync(realms, 0o000);
	try {
		const ran = await sweepOutside({ env: {} });

		expect(ran.end, "how the run ended").toBe("failed");
		expect(seen.claims, "the sweeps it ran").toEqual([]);
		expect(String(logLines()[0]?.failed), "the line it logged").toContain(
			`the realms at ${realms} can't be looked at`,
		);
	} finally {
		chmodSync(realms, 0o700);
	}
});

it("fails before sweeping when the realms folder is a link to nothing", async () => {
	// It may lead to realms elsewhere, whose quests would claim nothing.
	const realms = join(root, "data", "pi", "agentic-harness.pi", "realms");
	mkdirSync(join(realms, ".."), { recursive: true });
	symlinkSync(join(root, "realms-gone"), realms);

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how the run ended").toBe("failed");
	expect(seen.claims, "the sweeps it ran").toEqual([]);
	expect(String(logLines()[0]?.failed), "the line it logged").toContain(
		`the realms at ${realms} can't be looked at`,
	);
});

it("says a README that won't parse, though another folder holds its id", async () => {
	// Nothing took its place: a README that won't parse is never indexed.
	questListing(SPENT);
	const broken = join(seen.quests, "QEST-20260731-AAAAAA");
	writeFileSync(
		join(broken, "README.md"),
		"# A quest whose front matter went\n",
	);
	questListing("/src/repo/.worktrees/copy", { id: "QEST-20260731-BBBBBB" });
	const copy = join(seen.quests, "QEST-20260731-BBBBBB", "README.md");
	writeFileSync(
		copy,
		readFileSync(copy, "utf8").replace(
			"id: QEST-20260731-BBBBBB",
			"id: QEST-20260731-AAAAAA",
		),
	);

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how the run ended").toBe("failed");
	expect(String(logLines()[0]?.failed), "the line it logged").toContain(
		`the quest at ${broken} can't be read for its claims: Front-matter invalid`,
	);
});

it("fails before sweeping when another folder's README takes a quest's id", async () => {
	// The walk keeps one quest per id, so the other's trees would go.
	questListing(SPENT);
	questListing("/src/repo/.worktrees/copy", { id: "QEST-20260731-BBBBBB" });
	const copy = join(seen.quests, "QEST-20260731-BBBBBB", "README.md");
	writeFileSync(
		copy,
		readFileSync(copy, "utf8").replace(
			"id: QEST-20260731-BBBBBB",
			"id: QEST-20260731-AAAAAA",
		),
	);

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how the run ended").toBe("failed");
	expect(seen.claims, "the sweeps it ran").toEqual([]);
	// Whichever folder the walk read last keeps the id; the reason names
	// the other folder's quest either way.
	expect(String(logLines()[0]?.failed), "the line it logged").toMatch(
		/can't be read for its claims: (the README at .* names its id|its README names another folder's quest)/,
	);
});

it("fails before sweeping when a quest's folder is a link to nothing", async () => {
	// It may lead to a quest elsewhere, so it isn't one being made.
	const quest = join(seen.quests, "QEST-20260731-AAAAAA");
	symlinkSync(join(root, "quest-gone"), quest);

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how the run ended").toBe("failed");
	expect(String(logLines()[0]?.failed), "the line it logged").toContain(
		`the quest at ${quest} can't be read for its claims: it is a link`,
	);
});

it("fails before sweeping when a quest's folder is a link", async () => {
	// The walk doesn't follow it, so the trees it lists would go.
	const kept = join(root, "kept");
	questListing(SPENT, { store: kept });
	const quest = join(seen.quests, "QEST-20260731-AAAAAA");
	symlinkSync(join(kept, "QEST-20260731-AAAAAA"), quest);

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how the run ended").toBe("failed");
	expect(String(logLines()[0]?.failed), "the line it logged").toContain(
		`the quest at ${quest} can't be read for its claims: it is a link`,
	);
});

it("fails before sweeping when a realm is reached through a link", async () => {
	// No realm's reading follows the link, so its quests would claim nothing.
	const kept = mkdtempSync(join(tmpdir(), "realm-kept-"));
	const realm = join(otherRealmsQuests(), "..", "..");
	mkdirSync(join(realm, ".."), { recursive: true });
	symlinkSync(kept, realm);
	try {
		const ran = await sweepOutside({ env: {} });

		expect(ran.end, "how the run ended").toBe("failed");
		expect(seen.claims, "the sweeps it ran").toEqual([]);
		expect(String(logLines()[0]?.failed), "the line it logged").toContain(
			"is a link",
		);
	} finally {
		rmSync(kept, { recursive: true, force: true });
	}
});

it("fails before sweeping when another realm's quests are a link to nothing", async () => {
	// The quests may stand where the link points once it's back.
	const store = otherRealmsQuests();
	mkdirSync(join(store, ".."), { recursive: true });
	symlinkSync(join(root, "unmounted"), store);

	const ran = await sweepOutside({ env: {} });

	expect(ran.end, "how the run ended").toBe("failed");
	expect(seen.claims, "the sweeps it ran").toEqual([]);
	expect(String(logLines()[0]?.failed), "the line it logged").toContain(
		`the quests aren't at ${store}`,
	);
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
