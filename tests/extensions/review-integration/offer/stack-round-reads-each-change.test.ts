/**
 * A stack round counts as our own council for every change it read, at
 * that change's head, and for no head it didn't read: what the round
 * witnesses, what the ledger holds of it and what the ready gate asks
 * of the ledger, put together the way `review_ask stack` puts them.
 */

import { execFile } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDir } from "../../../../extensions/review-integration/engine.ts";
import {
	councilFirst,
	witnessCouncilsWith,
} from "../../../../extensions/review-integration/reviewed-first.ts";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import { stackWitnesses } from "../../../../lib/core/review/ask/stack-witness.ts";
import {
	type ChangeRef,
	createRunStore,
	runStackCouncil,
} from "../../../../lib/core/review/index.ts";
import { disposeRepo, freshRepo, git } from "../../../support/git-fixture.ts";

const REPO = "github:Jitsusama/mycelium";

const exec: Exec = async (command, args) =>
	new Promise((done) =>
		execFile(command, [...args], (error, stdout, stderr) =>
			done({
				code: error ? Number(error.code ?? 1) : 0,
				stdout: String(stdout),
				stderr: String(stderr),
			}),
		),
	);

/** The stack's branches, roots before children, each on the one before. */
const BRANCHES = ["bottom", "middle", "tip"] as const;

/** Each branch as the pull request it went up as. */
function proposalOf(index: number): ChangeRef {
	return {
		provider: "github",
		repo: { key: REPO },
		id: String(562 + index),
		label: `Jitsusama/mycelium#${562 + index}`,
	};
}

describe("a stack round over three changes", () => {
	let repo: string;
	const heads = new Map<string, string>();

	beforeEach(async () => {
		rmSync(runDir(), { recursive: true, force: true });
		witnessCouncilsWith(undefined);
		repo = await freshRepo("stack-round-reads-each-change");
		await git(
			repo,
			"update-ref",
			"refs/remotes/origin/main",
			await git(repo, "rev-parse", "HEAD"),
		);
		for (const name of BRANCHES) {
			await git(repo, "switch", "-qc", name);
			writeFileSync(join(repo, name), `${name}\n`);
			await git(repo, "add", name);
			await git(repo, "commit", "-qm", name);
			const head = await git(repo, "rev-parse", "HEAD");
			await git(repo, "update-ref", `refs/remotes/origin/${name}`, head);
			heads.set(name, head);
		}

		// What `review_ask stack` records: one round, held against the tip,
		// witnessing each head the tip's tree holds.
		const tip = heads.get("tip") ?? "";
		const { held } = await stackWitnesses(exec, repo, tip, heads);
		const { run } = await runStackCouncil(
			{
				roster: { reviewers: [{ id: "wren", model: "opus" }] },
				prompt: "read the stack",
				seq: 1,
				stackRefs: [...BRANCHES],
				witnessFor: (ref) => held.get(ref),
				witnesses: [...held.values()],
			},
			{
				ask: async () => ({ text: JSON.stringify({ findings: [] }) }),
				record: async () => [],
				now: () => new Date(),
			},
		);
		await createRunStore(runDir()).record(proposalOf(2), run);
	});

	afterEach(() => {
		disposeRepo(repo);
		heads.clear();
		witnessCouncilsWith(async () => true);
	});

	/** The change on `name`, at its head, as ready asks about it. */
	const change = (name: (typeof BRANCHES)[number], base: string) => ({
		repo: REPO,
		checkout: repo,
		base,
		head: name,
		headCommit: heads.get(name) ?? "",
	});

	it("lets the bottom change through at its head", async () => {
		expect(
			await councilFirst(exec, change("bottom", "main"), "marked ready"),
		).toBeUndefined();
	});

	it("lets the middle change through at its head", async () => {
		expect(
			await councilFirst(exec, change("middle", "bottom"), "marked ready"),
		).toBeUndefined();
	});

	it("holds a head none of its reviewers read", async () => {
		// A change stacked on the tip after the round, which it never read.
		await git(repo, "switch", "-qc", "above");
		writeFileSync(join(repo, "above"), "above\n");
		await git(repo, "add", "above");
		await git(repo, "commit", "-qm", "above");
		const above = await git(repo, "rev-parse", "HEAD");
		await git(repo, "update-ref", "refs/remotes/origin/above", above);

		expect(
			await councilFirst(
				exec,
				{
					repo: REPO,
					checkout: repo,
					base: "tip",
					head: "above",
					headCommit: above,
				},
				"marked ready",
			),
		).toContain("No council of ours has read tip..above");
	});
});
