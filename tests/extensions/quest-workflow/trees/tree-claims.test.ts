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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	answerTreeClaims,
	forgetSweptTrees,
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

	it("names a live quest's last-listed tree as its newest for an asker that offers that list", () => {
		const pi = bus();
		answerTreeClaims(
			pi as never,
			questsRootHolding(
				"/src/repo/.worktrees/first",
				"/src/repo/.worktrees/last",
			),
		);

		const claims: TreeClaims = { paths: [], untilSpent: [], newest: [] };
		pi.events.emit(WORK_TREE_CLAIMS, claims);

		expect(claims.untilSpent, "held until spent").toEqual([
			"/src/repo/.worktrees/first",
			"/src/repo/.worktrees/last",
		]);
		expect(claims.newest, "its newest").toEqual(["/src/repo/.worktrees/last"]);
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
