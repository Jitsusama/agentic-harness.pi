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

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type TreeClaims,
	WORK_TREE_CLAIMS,
} from "@jitsusama/agentic-harness.core/work";
import { describe, expect, it } from "vitest";
import { answerTreeClaims } from "../../../extensions/quest-workflow/claims.js";

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

/** A quests root holding one quest that lists the given trees. */
function questsRootHolding(...paths: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "claims-quests-"));
	const id = "QEST-20260731-AAAAAA";
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
		`---\nid: ${id}\nkind: quest\nstatus: active\npriority: active\n` +
			`rank: 1\nstarted: 2026-07-31\nupdated: 2026-07-31\n` +
			(paths.length > 0 ? `trees:\n${trees}` : "") +
			`---\n\n# Holding trees\n\n## Summary\n\nA quest with trees.\n`,
	);
	return root;
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

	it("claims nothing when no quest holds a tree", () => {
		const pi = bus();
		answerTreeClaims(pi as never, questsRootHolding());

		const claims: TreeClaims = { paths: [] };
		pi.events.emit(WORK_TREE_CLAIMS, claims);

		expect(claims.paths).toEqual([]);
	});
});
