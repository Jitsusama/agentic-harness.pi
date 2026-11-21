/**
 * A council another machine ran counts as our own review first.
 *
 * Equilibrius runs rounds while optimus's memory holds councils back,
 * and its ledger is mirrored under runs-from/<node>. Before the gate
 * read the mirror, every such council was invisible here, so each
 * change waited for a last round on optimus (1JQPPC, 21 Nov).
 */

import { execFile } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mirroredRunsDir,
	runDir,
} from "../../../../extensions/review-integration/engine.ts";
import {
	councilFirst,
	witnessCouncilsWith,
} from "../../../../extensions/review-integration/reviewed-first.ts";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import {
	type ChangeRef,
	createRunStore,
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

/** A finished council in `ledger`, for `repo`, whose reviewers read `witness`. */
async function councilIn(ledger: string, repo: string, witness: string) {
	const range: ChangeRef = {
		provider: "local-range",
		repo: { key: repo },
		id: "origin/main..topic",
		label: "origin/main..topic",
	};
	await createRunStore(ledger).record(range, {
		id: `council-${witness}`,
		round: "council",
		startedAt: new Date().toISOString(),
		participants: [{ id: "hawk", role: "reviewer" }],
		outcomes: [{ participantId: "hawk", findingIds: [] }],
		witness,
	});
}

describe("counting a council another machine ran", () => {
	let repo: string;
	let head: string;
	const equilibrius = () => join(mirroredRunsDir(), "equilibrius");
	const topic = () => ({
		repo: REPO,
		checkout: repo,
		base: "main",
		head: "topic",
	});

	beforeEach(async () => {
		rmSync(runDir(), { recursive: true, force: true });
		rmSync(mirroredRunsDir(), { recursive: true, force: true });
		witnessCouncilsWith(undefined);
		repo = await freshRepo("reviewed-first-mirrored");
		await git(repo, "switch", "-qc", "topic");
		writeFileSync(join(repo, "one"), "one\n");
		await git(repo, "add", "one");
		await git(repo, "commit", "-qm", "one");
		head = await git(repo, "rev-parse", "HEAD");
	});

	afterEach(() => {
		disposeRepo(repo);
		rmSync(mirroredRunsDir(), { recursive: true, force: true });
		witnessCouncilsWith(async () => true);
	});

	it("lets a change through on a council mirrored from another machine", async () => {
		await councilIn(equilibrius(), REPO, head);

		expect(
			await councilFirst(exec, topic(), "proposed"),
			"a mirrored council that read the head counts",
		).toBeUndefined();
		expect(
			existsSync(runDir()),
			"nothing is written into this machine's ledger",
		).toBe(false);
	});

	it("holds it back when the mirrored council was of another repo", async () => {
		await councilIn(equilibrius(), "github:Jitsusama/other", head);

		expect(
			await councilFirst(exec, topic(), "proposed"),
			"a council of another repo at the same commit does not count",
		).toContain("isn't proposed");
	});

	it("holds it back with no mirror, as before", async () => {
		expect(
			await councilFirst(exec, topic(), "proposed"),
			"with no council anywhere the change waits",
		).toContain("isn't proposed");
	});
});
