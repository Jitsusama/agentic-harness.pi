/**
 * The quest workflow answering the working layer's claims question.
 *
 * Tested from the bus outwards rather than by calling the collector,
 * because the failure this guards against is not a wrong answer. It is
 * no answer: a listener never wired up, or wired to a name nothing
 * emits, in which case reclamation sees an empty claim list and calls
 * a quest's tree abandoned. A test that called the function directly
 * would pass against exactly that system.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	answerTreeClaims,
	forgetSweptTrees,
	forgetTrees,
	liveQuestClaims,
} from "../../../../extensions/quest-workflow/claims.ts";
import {
	type SweptTrees,
	type TreeClaims,
	WORK_TREE_CLAIMS,
	WORK_TREES_SWEPT,
} from "../../../../lib/core/work/index.ts";
import {
	clearDiscoveryCache,
	discoverQuests,
} from "../../../../lib/internal/quest/discovery/discovery.ts";
import { settle } from "../../../lib/internal/quest/support/discovery-tree.ts";
import { installTestHost } from "../../../support/session-host.ts";

/** Just enough of pi's bus for a listener to be reached over it. */
function bus() {
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	return {
		events: {
			on(name: string, fn: (data: unknown) => void) {
				listeners.set(name, [...(listeners.get(name) ?? []), fn]);
			},
			emit(name: string, data: unknown) {
				for (const fn of listeners.get(name) ?? []) fn(data);
			},
		},
	};
}

/** A quests root holding one active quest that lists the given trees. */
function questsRootHolding(...paths: string[]): string {
	return questsRootWith("active", ...paths);
}

/** A quests root holding one quest of `status` that lists the given trees. */
function questsRootWith(status: string, ...paths: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "claims-quests-"));
	questListing(root, "QEST-20260731-AAAAAA", status, ...paths);
	return root;
}

/** Write quest `id` into `root`, of `status`, listing the given trees. */
function questListing(
	root: string,
	id: string,
	status: string,
	...paths: string[]
): string {
	mkdirSync(join(root, id), { recursive: true });
	const trees = paths
		.map(
			(path) =>
				`  - path: ${path}\n    providerId: git-worktree\n` +
				`    repoRoot: ${path}\n    origin: cut\n`,
		)
		.join("");
	writeFileSync(
		join(root, id, "README.md"),
		`---\nid: ${id}\nkind: quest\nstatus: ${status}\npriority: active\n` +
			"rank: 1\nstarted: 2026-07-31\nupdated: 2026-07-31\n" +
			(paths.length > 0 ? `trees:\n${trees}` : "") +
			"---\n\n# Holding trees\n\n## Summary\n\nA quest with trees.\n",
	);
	return join(root, id, "README.md");
}

/** A tree a quest lists, in `repo`, on `host` (this machine by default). */
interface Placed {
	path: string;
	repo?: string;
	host?: string;
}

/** Write quest `id` into `root`, live, listing `trees` in order. */
function questPlacing(root: string, id: string, ...trees: Placed[]): string {
	mkdirSync(join(root, id), { recursive: true });
	const listed = trees
		.map(
			(tree) =>
				`  - path: ${tree.path}\n    providerId: git-worktree\n` +
				(tree.repo === undefined ? "" : `    repoRoot: ${tree.repo}\n`) +
				`    host: ${tree.host ?? hostname()}\n    origin: cut\n`,
		)
		.join("");
	const readme = join(root, id, "README.md");
	writeFileSync(
		readme,
		`---\nid: ${id}\nkind: quest\nstatus: active\npriority: active\n` +
			"rank: 1\nstarted: 2026-07-31\nupdated: 2026-07-31\n" +
			`trees:\n${listed}` +
			"---\n\n# Holding trees\n\n## Summary\n\nA quest with trees.\n",
	);
	return readme;
}

/** A folder for each of `names` under a fresh one, standing as trees do. */
function standing(...names: string[]): string[] {
	const top = mkdtempSync(join(tmpdir(), "claims-trees-"));
	return names.map((name) => {
		const path = join(top, name);
		mkdirSync(path, { recursive: true });
		return path;
	});
}

/** What a live quest in `root` lets idle rules take, asked once. */
function letGo(root: string): string[] | undefined {
	const pi = bus();
	answerTreeClaims(pi as never, root);
	const claims: TreeClaims = { paths: [], untilSpent: [], idleMayTake: [] };
	pi.events.emit(WORK_TREE_CLAIMS, claims);
	return claims.idleMayTake;
}

describe("answering who holds a tree", () => {
	it("names a quest's trees when the working layer asks", () => {
		const root = questsRootHolding("/src/repo/.worktrees/mine");
		const pi = bus();
		answerTreeClaims(pi as never, root);

		const claims: TreeClaims = { paths: [] };
		pi.events.emit(WORK_TREE_CLAIMS, claims);

		expect(claims.paths).toEqual(["/src/repo/.worktrees/mine"]);
	});

	it("appends rather than replacing, so no other holder is dropped", () => {
		const root = questsRootHolding("/src/repo/.worktrees/mine");
		const pi = bus();
		answerTreeClaims(pi as never, root);

		// Somebody else answered first. Their claim has to survive, or the
		// last handler to run decides what is safe for everybody.
		const claims: TreeClaims = { paths: ["/src/other/.worktrees/theirs"] };
		pi.events.emit(WORK_TREE_CLAIMS, claims);

		expect(claims.paths).toEqual([
			"/src/other/.worktrees/theirs",
			"/src/repo/.worktrees/mine",
		]);
	});

	it("leaves a finished quest's trees to the working layer's own judgement", () => {
		// A quest that is over is nobody's reason to keep a tree: claimed
		// for good, its trees were never offered back, since the prune that
		// would release them is never run once the quest is done.
		for (const status of ["concluded", "retired"]) {
			const pi = bus();
			answerTreeClaims(
				pi as never,
				questsRootWith(status, "/src/repo/.worktrees/done"),
			);

			const claims: TreeClaims = { paths: [] };
			pi.events.emit(WORK_TREE_CLAIMS, claims);

			expect(claims.paths, status).toEqual([]);
		}
	});

	it("still claims the trees of a quest that is only paused or blocked", () => {
		for (const status of ["paused", "blocked"]) {
			const pi = bus();
			answerTreeClaims(
				pi as never,
				questsRootWith(status, "/src/repo/.worktrees/waiting"),
			);

			const claims: TreeClaims = { paths: [] };
			pi.events.emit(WORK_TREE_CLAIMS, claims);

			expect(claims.paths, status).toEqual(["/src/repo/.worktrees/waiting"]);
		}
	});

	it("claims another realm's quests' trees too, since the machine's trees are shared", () => {
		// A personal session sweeping trees must still see the work
		// realm's quests holding theirs, and the other way round.
		const data = process.env.XDG_DATA_HOME ?? "";
		const personal = join(
			data,
			"pi",
			"agentic-harness.pi",
			"realms",
			"personal",
			"quest-workflow",
		);
		mkdirSync(personal, { recursive: true });
		const theirs = questsRootHolding("/src/core/.worktrees/personal");
		renameSync(theirs, join(personal, "quests"));
		try {
			const pi = bus();
			answerTreeClaims(
				pi as never,
				questsRootHolding("/src/repo/.worktrees/mine"),
			);

			const claims: TreeClaims = { paths: [] };
			pi.events.emit(WORK_TREE_CLAIMS, claims);

			expect(claims.paths).toEqual(
				expect.arrayContaining([
					"/src/repo/.worktrees/mine",
					"/src/core/.worktrees/personal",
				]),
			);
		} finally {
			rmSync(join(data, "pi", "agentic-harness.pi", "realms"), {
				recursive: true,
				force: true,
			});
		}
	});

	it("claims nothing when no quest holds a tree", () => {
		const pi = bus();
		answerTreeClaims(pi as never, questsRootHolding());

		const claims: TreeClaims = { paths: [] };
		pi.events.emit(WORK_TREE_CLAIMS, claims);

		expect(claims.paths).toEqual([]);
	});

	it("holds a live quest's trees only until spent for an asker that offers that list", () => {
		// A quest lists every tree it ever cut, and claiming them for good
		// kept 220 ended trees of 456 on one machine: the sweep judges them
		// by reclaim's rules instead, once their sessions have ended.
		const pi = bus();
		answerTreeClaims(
			pi as never,
			questsRootHolding("/src/repo/.worktrees/mine"),
		);

		const claims: TreeClaims = { paths: [], untilSpent: [] };
		pi.events.emit(WORK_TREE_CLAIMS, claims);

		expect(claims.paths, "held for good").toEqual([]);
		expect(claims.untilSpent, "held until spent").toEqual([
			"/src/repo/.worktrees/mine",
		]);
	});

	it("lets idle rules take a live quest's trees here but its newest in each repository", () => {
		const root = mkdtempSync(join(tmpdir(), "claims-quests-"));
		const [first, only, last, unknownFirst, unknownLast, away] = standing(
			"a/first",
			"b/only",
			"a/last-here",
			"a/unknown-first",
			"a/unknown-last",
			"a/other-machine",
		);
		questPlacing(
			root,
			"QEST-20260731-AAAAAA",
			{ path: `${first}`, repo: "/src/a" },
			{ path: `${only}`, repo: "/src/b" },
			{ path: `${last}`, repo: "/src/a" },
			{ path: `${unknownFirst}` },
			{ path: `${unknownLast}` },
			{ path: `${away}`, repo: "/src/a", host: "away" },
		);

		expect(
			letGo(root),
			"only an older tree here whose repository is known",
		).toEqual([first]);
	});

	it("keeps the tree before a repository's last when the last's folder is gone", () => {
		const root = mkdtempSync(join(tmpdir(), "claims-quests-"));
		const [first, before] = standing("a/first", "a/before-gone");
		questPlacing(
			root,
			"QEST-20260731-AAAAAA",
			{ path: `${first}`, repo: "/src/a" },
			{ path: `${before}`, repo: "/src/a" },
			{ path: `${before}-gone-since`, repo: "/src/a" },
		);

		expect(letGo(root), "the older one alone, not the one reopened in").toEqual(
			[first],
		);
	});

	it("never lets idle rules take a tree another live quest holds as its newest", () => {
		const root = mkdtempSync(join(tmpdir(), "claims-quests-"));
		const [sharedPath, later] = standing("a/shared", "a/later");
		const shared = { path: `${sharedPath}`, repo: "/src/a" };
		questPlacing(root, "QEST-20260731-AAAAAA", shared, {
			path: `${later}`,
			repo: "/src/a",
		});
		questPlacing(root, "QEST-20260731-BBBBBB", shared);

		expect(letGo(root), "another quest's newest").toEqual([]);
	});

	it("lets idle rules take nothing while a walk leaves a quest out, since it may hold any tree", () => {
		const root = mkdtempSync(join(tmpdir(), "claims-quests-"));
		const [first, last] = standing("a/first", "a/last");
		questPlacing(
			root,
			"QEST-20260731-AAAAAA",
			{ path: `${first}`, repo: "/src/a" },
			{ path: `${last}`, repo: "/src/a" },
		);
		// Another quest's README is mid-write as the walk reads it.
		mkdirSync(join(root, "QEST-20260731-BBBBBB"));
		writeFileSync(
			join(root, "QEST-20260731-BBBBBB", "README.md"),
			"---\nid: QEST-20260731-BBBBBB\n",
		);

		expect(letGo(root), "a host's answer, off a host").toEqual([]);
		expect(
			liveQuestClaims(root).idleMayTake,
			"the outside sweep's answer",
		).toEqual([]);
	});

	it("never lets idle rules take a tree another live quest lists with no repository", () => {
		const root = mkdtempSync(join(tmpdir(), "claims-quests-"));
		const [shared, later] = standing("a/shared", "a/later");
		questPlacing(
			root,
			"QEST-20260731-AAAAAA",
			{ path: `${shared}`, repo: "/src/a" },
			{ path: `${later}`, repo: "/src/a" },
		);
		questPlacing(root, "QEST-20260731-BBBBBB", { path: `${shared}` });

		expect(letGo(root), "a tree the other quest keeps").toEqual([]);
	});

	it("lets idle rules take nothing of an asker that offers no list for it", () => {
		const root = mkdtempSync(join(tmpdir(), "claims-quests-"));
		const [first, last] = standing("a/first", "a/last");
		questPlacing(
			root,
			"QEST-20260731-AAAAAA",
			{ path: `${first}`, repo: "/src/a" },
			{ path: `${last}`, repo: "/src/a" },
		);
		const pi = bus();
		answerTreeClaims(pi as never, root);

		const claims: TreeClaims = { paths: [], untilSpent: [] };
		pi.events.emit(WORK_TREE_CLAIMS, claims);

		expect(claims, "the claims, with no list added").toEqual({
			paths: [],
			untilSpent: [first, last],
		});
	});

	it("gives an asker that waits nothing more to wait on, since its walk is fresh", () => {
		const pi = bus();
		answerTreeClaims(
			pi as never,
			questsRootHolding("/src/repo/.worktrees/mine"),
		);

		const claims: TreeClaims = { paths: [], answering: [] };
		pi.events.emit(WORK_TREE_CLAIMS, claims);

		expect(claims.paths).toEqual(["/src/repo/.worktrees/mine"]);
		expect(claims.answering, "answers still to come").toEqual([]);
	});

	it("drops a tree a sweep took from the quest that listed it", async () => {
		const root = questsRootHolding(
			"/src/repo/.worktrees/spent",
			"/src/repo/.worktrees/working",
		);
		const pi = bus();
		answerTreeClaims(pi as never, root);
		forgetSweptTrees(pi as never, root);

		const swept: SweptTrees = { paths: ["/src/repo/.worktrees/spent"] };
		pi.events.emit(WORK_TREES_SWEPT, swept);

		await vi.waitFor(() => {
			const claims: TreeClaims = { paths: [] };
			pi.events.emit(WORK_TREE_CLAIMS, claims);
			expect(claims.paths, "what the quest lists after the sweep").toEqual([
				"/src/repo/.worktrees/working",
			]);
		});
	});
});

describe("answering who holds a tree on a host", () => {
	let host: ReturnType<typeof installTestHost>;

	beforeEach(() => {
		clearDiscoveryCache();
		host = installTestHost();
	});

	afterEach(() => {
		host.dispose();
		clearDiscoveryCache();
	});

	it("answers an asker that waits with a tree listed since the last walk", async () => {
		const root = questsRootHolding("/src/repo/.worktrees/mine");
		const readme = join(root, "QEST-20260731-AAAAAA", "README.md");
		settle(readme);
		settle(join(root, "QEST-20260731-AAAAAA"));
		settle(root);
		discoverQuests(root);
		const pi = bus();
		answerTreeClaims(pi as never, root);

		// Another process lists a second tree, which the last walk predates.
		const text = readFileSync(readme, "utf8");
		writeFileSync(
			readme,
			text.replace(
				"trees:\n",
				"trees:\n  - path: /src/repo/.worktrees/new\n" +
					"    providerId: git-worktree\n" +
					"    repoRoot: /src/repo/.worktrees/new\n    origin: cut\n",
			),
		);
		settle(readme);
		const claims: TreeClaims = { paths: [], answering: [] };
		pi.events.emit(WORK_TREE_CLAIMS, claims);
		await Promise.all(claims.answering ?? []);

		expect(claims.paths).toContain("/src/repo/.worktrees/new");
	});

	it("lets idle rules take a tree an asker that waits hears was outgrown since the last walk", async () => {
		const root = mkdtempSync(join(tmpdir(), "claims-quests-"));
		const [firstPath, newer] = standing("a/first", "a/newer");
		const first = { path: `${firstPath}`, repo: "/src/a" };
		const readme = questPlacing(root, "QEST-20260731-AAAAAA", first);
		settle(readme);
		settle(join(root, "QEST-20260731-AAAAAA"));
		settle(root);
		discoverQuests(root);
		const pi = bus();
		answerTreeClaims(pi as never, root);

		// Another process cuts a newer tree in the same repository.
		questPlacing(root, "QEST-20260731-AAAAAA", first, {
			path: `${newer}`,
			repo: "/src/a",
		});
		settle(readme);
		const claims: TreeClaims = {
			paths: [],
			untilSpent: [],
			idleMayTake: [],
			answering: [],
		};
		pi.events.emit(WORK_TREE_CLAIMS, claims);
		expect(claims.idleMayTake, "the last walk's newest").toEqual([]);
		await Promise.all(claims.answering ?? []);

		expect(claims.idleMayTake, "the fresh walk's older tree").toEqual([
			firstPath,
		]);
	});

	it("takes back a tree the last walk let go once an asker that waits hears it is newest", async () => {
		const root = mkdtempSync(join(tmpdir(), "claims-quests-"));
		const [firstPath, newer] = standing("a/first", "a/newer");
		const first = { path: `${firstPath}`, repo: "/src/a" };
		const readme = questPlacing(root, "QEST-20260731-AAAAAA", first, {
			path: `${newer}`,
			repo: "/src/a",
		});
		settle(readme);
		settle(join(root, "QEST-20260731-AAAAAA"));
		settle(root);
		discoverQuests(root);
		const pi = bus();
		answerTreeClaims(pi as never, root);

		// Another process releases the newer tree, leaving the first newest.
		questPlacing(root, "QEST-20260731-AAAAAA", first);
		settle(readme);
		const claims: TreeClaims = {
			paths: [],
			untilSpent: [],
			idleMayTake: [],
			answering: [],
		};
		pi.events.emit(WORK_TREE_CLAIMS, claims);
		expect(claims.idleMayTake, "the last walk's older tree").toEqual([
			firstPath,
		]);
		await Promise.all(claims.answering ?? []);

		expect(claims.idleMayTake, "the fresh walk's newest, taken back").toEqual(
			[],
		);
	});

	it("keeps every tree a quest listed in the last walk when a fresh walk can't read that quest", async () => {
		const root = mkdtempSync(join(tmpdir(), "claims-quests-"));
		const [shared, newer, before] = standing("a/shared", "a/newer", "a/before");
		const outgrown = questPlacing(
			root,
			"QEST-20260731-AAAAAA",
			{ path: `${shared}`, repo: "/src/a" },
			{ path: `${newer}`, repo: "/src/a" },
		);
		const holder = questPlacing(
			root,
			"QEST-20260731-BBBBBB",
			{ path: `${before}`, repo: "/src/a" },
			{ path: `${shared}`, repo: "/src/a" },
		);
		settle(outgrown);
		settle(holder);
		settle(join(root, "QEST-20260731-AAAAAA"));
		settle(join(root, "QEST-20260731-BBBBBB"));
		settle(root);
		discoverQuests(root);
		const pi = bus();
		answerTreeClaims(pi as never, root);

		// The holder's README is mid-write as the fresh walk reads it.
		writeFileSync(holder, "---\nid: QEST-20260731-BBBBBB\n");
		settle(holder);
		const claims: TreeClaims = {
			paths: [],
			untilSpent: [],
			idleMayTake: [],
			answering: [],
		};
		pi.events.emit(WORK_TREE_CLAIMS, claims);
		expect(claims.idleMayTake, "the last walk's holder").toEqual([before]);
		await Promise.all(claims.answering ?? []);

		expect(
			claims.idleMayTake,
			"a fresh walk that couldn't read the holder",
		).toEqual([]);
	});

	it("lets idle rules take nothing while neither walk reads a quest, since it may hold any tree", async () => {
		const root = mkdtempSync(join(tmpdir(), "claims-quests-"));
		const [first, last] = standing("a/first", "a/last");
		const readme = questPlacing(
			root,
			"QEST-20260731-AAAAAA",
			{ path: `${first}`, repo: "/src/a" },
			{ path: `${last}`, repo: "/src/a" },
		);
		// Another quest's README won't parse, for the last walk and the next.
		const unread = join(root, "QEST-20260731-BBBBBB");
		mkdirSync(unread);
		writeFileSync(join(unread, "README.md"), "---\nid: QEST-20260731-BBBBBB\n");
		settle(readme);
		settle(join(unread, "README.md"));
		settle(join(root, "QEST-20260731-AAAAAA"));
		settle(unread);
		settle(root);
		discoverQuests(root);
		const pi = bus();
		answerTreeClaims(pi as never, root);

		const waits: TreeClaims = {
			paths: [],
			untilSpent: [],
			idleMayTake: [],
			answering: [],
		};
		pi.events.emit(WORK_TREE_CLAIMS, waits);
		await Promise.all(waits.answering ?? []);
		expect(waits.idleMayTake, "an asker that waits").toEqual([]);

		const hears: TreeClaims = { paths: [], untilSpent: [], idleMayTake: [] };
		pi.events.emit(WORK_TREE_CLAIMS, hears);
		expect(hears.idleMayTake, "an asker that hears only the last walk").toEqual(
			[],
		);
	});
});

describe("hearing that a sweep took a tree", () => {
	let host: ReturnType<typeof installTestHost>;

	beforeEach(() => {
		clearDiscoveryCache();
		host = installTestHost();
	});

	afterEach(() => {
		host.dispose();
		clearDiscoveryCache();
	});

	/**
	 * How long a forgetting may take to land: on a host it waits on a
	 * signing, read on a thread of its own, which a busy machine is slow
	 * to start; within the test's own five seconds.
	 */
	const FORGETS_WITHIN = { timeout: 4_000 };

	/**
	 * What the quests under `root` list, once the forgetting settles. A
	 * host answers no claims before its first walk, so an empty answer is
	 * one from before the forgetting read the tree.
	 */
	function listedOnceGone(
		pi: ReturnType<typeof bus>,
		gone: string,
	): Promise<string[]> {
		return vi.waitFor(() => {
			const claims: TreeClaims = { paths: [] };
			pi.events.emit(WORK_TREE_CLAIMS, claims);
			expect(claims.paths, "the tree the sweep took").not.toContain(gone);
			expect(claims.paths, "read since the sweep").not.toEqual([]);
			return claims.paths;
		}, FORGETS_WITHIN);
	}

	it("drops a tree the sweep took from the quest that listed it", async () => {
		const root = questsRootHolding(
			"/src/repo/.worktrees/spent",
			"/src/repo/.worktrees/working",
		);
		const pi = bus();
		answerTreeClaims(pi as never, root);
		forgetSweptTrees(pi as never, root);

		const swept: SweptTrees = { paths: ["/src/repo/.worktrees/spent"] };
		pi.events.emit(WORK_TREES_SWEPT, swept);

		// It reads the tree afresh before it writes, so it ends a moment on.
		await vi.waitFor(() => {
			const claims: TreeClaims = { paths: [] };
			pi.events.emit(WORK_TREE_CLAIMS, claims);
			expect(claims.paths, "what the quest lists after the sweep").toEqual([
				"/src/repo/.worktrees/working",
			]);
		}, FORGETS_WITHIN);
	});

	/**
	 * Whether a quest still names `open-change` as its branch once a sweep
	 * took the tree on it, saying it deleted `gone`.
	 */
	async function aliasKeptWhenGone(gone: string[]): Promise<boolean> {
		const root = mkdtempSync(join(tmpdir(), "claims-quests-"));
		const id = "QEST-20260731-AAAAAA";
		mkdirSync(join(root, id));
		const readme = join(root, id, "README.md");
		writeFileSync(
			readme,
			`---\nid: ${id}\nkind: quest\nstatus: active\npriority: active\n` +
				"rank: 1\nstarted: 2026-07-31\nupdated: 2026-07-31\n" +
				"aliases:\n  - type: git-branch\n    value: open-change\n" +
				"trees:\n  - path: /src/repo/.worktrees/spent\n" +
				"    branch: open-change\n    providerId: git-worktree\n" +
				"    repoRoot: /src/repo\n    origin: cut\n" +
				"  - path: /src/repo/.worktrees/working\n    providerId: git-worktree\n" +
				"    repoRoot: /src/repo\n    origin: cut\n" +
				"---\n\n# Holding trees\n\n## Summary\n\nA quest with trees.\n",
		);
		const pi = bus();
		answerTreeClaims(pi as never, root);
		forgetSweptTrees(pi as never, root);

		const swept: SweptTrees = {
			paths: ["/src/repo/.worktrees/spent"],
			branchesGone: gone,
		};
		pi.events.emit(WORK_TREES_SWEPT, swept);

		await listedOnceGone(pi, "/src/repo/.worktrees/spent");
		return readFileSync(readme, "utf8").includes("value: open-change");
	}

	it("keeps the alias of a swept tree's branch that still stands, so a change on it finds its quest", async () => {
		expect(await aliasKeptWhenGone([]), "the branch's alias").toBe(true);
	});

	it("drops the alias of a swept tree's branch the sweep deleted", async () => {
		const kept = await aliasKeptWhenGone(["open-change"]);
		expect(kept, "the branch's alias").toBe(false);
	});

	it("drops an alias an earlier take left once a later run deletes its branch, keeping a listed tree's", async () => {
		const root = mkdtempSync(join(tmpdir(), "claims-quests-"));
		const id = "QEST-20260731-AAAAAA";
		mkdirSync(join(root, id));
		const readme = join(root, id, "README.md");
		writeFileSync(
			readme,
			`---\nid: ${id}\nkind: quest\nstatus: active\npriority: active\n` +
				"rank: 1\nstarted: 2026-07-31\nupdated: 2026-07-31\n" +
				"aliases:\n  - type: git-branch\n    value: taken-earlier\n" +
				"  - type: git-branch\n    value: still-listed\n" +
				"trees:\n  - path: /src/repo/.worktrees/working\n" +
				"    branch: still-listed\n    providerId: git-worktree\n" +
				"    repoRoot: /src/repo\n    origin: cut\n" +
				"---\n\n# Holding trees\n\n## Summary\n\nA quest with trees.\n",
		);
		await forgetTrees(root, [], ["taken-earlier", "still-listed"]);

		const after = readFileSync(readme, "utf8");
		expect(
			after.includes("value: taken-earlier"),
			"the alias of a deleted branch no listed tree is on",
		).toBe(false);
		expect(
			after.includes("value: still-listed"),
			"the alias of a branch a listed tree is on",
		).toBe(true);
	});

	it("leaves a quest's trees alone when the sweep took others", async () => {
		const root = questsRootHolding(
			"/src/repo/.worktrees/mine",
			"/src/repo/.worktrees/spent",
		);
		const pi = bus();
		answerTreeClaims(pi as never, root);
		forgetSweptTrees(pi as never, root);

		const swept: SweptTrees = {
			paths: ["/src/repo/.worktrees/nobodys", "/src/repo/.worktrees/spent"],
		};
		pi.events.emit(WORK_TREES_SWEPT, swept);

		// Read once the tree it did take is gone, so the forgetting has run.
		const listed = await listedOnceGone(pi, "/src/repo/.worktrees/spent");
		expect(listed, "what the quest lists after the sweep").toEqual([
			"/src/repo/.worktrees/mine",
		]);
	});

	it("keeps listing a tree cut again at the path the sweep took", async () => {
		const recut = mkdtempSync(join(tmpdir(), "claims-recut-"));
		try {
			const root = questsRootHolding(recut, "/src/repo/.worktrees/spent");
			const pi = bus();
			answerTreeClaims(pi as never, root);
			forgetSweptTrees(pi as never, root);

			const swept: SweptTrees = {
				paths: [recut, "/src/repo/.worktrees/spent"],
			};
			pi.events.emit(WORK_TREES_SWEPT, swept);

			const listed = await listedOnceGone(pi, "/src/repo/.worktrees/spent");
			expect(listed, "a folder that is there again").toEqual([recut]);
		} finally {
			rmSync(recut, { recursive: true, force: true });
		}
	});

	// Root writes a folder whatever its mode, so the locked quest isn't.
	it.skipIf(process.getuid?.() === 0)(
		"forgets in every other quest when one quest's write fails, and throws nothing",
		async () => {
			const root = questsRootHolding("/src/repo/.worktrees/spent");
			const locked = questListing(
				root,
				"QEST-20260731-BBBBBB",
				"active",
				"/src/repo/.worktrees/spent",
			);
			const said = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			const lockedDir = join(locked, "..");
			chmodSync(lockedDir, 0o500);
			try {
				const pi = bus();
				answerTreeClaims(pi as never, root);
				forgetSweptTrees(pi as never, root);

				const swept: SweptTrees = { paths: ["/src/repo/.worktrees/spent"] };
				pi.events.emit(WORK_TREES_SWEPT, swept);

				await vi.waitFor(() => {
					const text = readFileSync(
						join(root, "QEST-20260731-AAAAAA", "README.md"),
						"utf8",
					);
					expect(text, "the quest it could write").not.toContain("spent");
					const lines = said.mock.calls.map(([line]) => String(line));
					expect(lines.join("")).toContain("QEST-20260731-BBBBBB");
				}, FORGETS_WITHIN);
			} finally {
				chmodSync(lockedDir, 0o700);
				said.mockRestore();
			}
		},
	);
});
