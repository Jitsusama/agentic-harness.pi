/**
 * Whether our own council has read a change, judged from the change's
 * commits in its checkout and the rounds held on disk.
 */

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDir } from "../../../../extensions/review-integration/engine.ts";
import {
	councilFirst,
	witnessCouncilsWith,
} from "../../../../extensions/review-integration/reviewed-first.ts";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import {
	type AskRun,
	type ChangeRef,
	createRunStore,
} from "../../../../lib/core/review/index.ts";
import { disposeRepo, freshRepo, git } from "../../../support/git-fixture.ts";

const REPO = "github:Shopify/world";

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

/** A finished council whose reviewers read `witness`, held against a local range. */
async function councilRead(witness: string, over: Partial<AskRun> = {}) {
	const range: ChangeRef = {
		provider: "local-range",
		repo: { key: REPO },
		id: "origin/main..topic",
		label: "origin/main..topic",
	};
	await createRunStore(runDir()).record(range, {
		id: `council-${witness}`,
		round: "council",
		startedAt: new Date().toISOString(),
		participants: [{ id: "hawk", role: "reviewer" }],
		outcomes: [{ participantId: "hawk", findingIds: [] }],
		witness,
		...over,
	});
}

describe("holding a change until our own council has read it", () => {
	let repo: string;
	let trunk: string;
	let first: string;
	let fix: string;

	beforeEach(async () => {
		witnessCouncilsWith(undefined);
		repo = await freshRepo("reviewed-first");
		trunk = await git(repo, "rev-parse", "HEAD");
		await git(repo, "switch", "-qc", "topic");
		for (const name of ["one", "two"]) {
			writeFileSync(join(repo, name), `${name}\n`);
			await git(repo, "add", name);
			await git(repo, "commit", "-qm", name);
		}
		fix = await git(repo, "rev-parse", "HEAD");
		first = await git(repo, "rev-parse", "HEAD~1");
	});

	afterEach(() => {
		disposeRepo(repo);
		witnessCouncilsWith(async () => true);
	});

	const topic = () => ({
		repo: REPO,
		checkout: repo,
		base: "main",
		head: "topic",
	});

	it("lets it through once a council read its head", async () => {
		await councilRead(fix);

		expect(await councilFirst(exec, topic(), "proposed")).toBeUndefined();
	});

	it("lets it through when the council read it before a last fix", async () => {
		await councilRead(first);

		expect(await councilFirst(exec, topic(), "proposed")).toBeUndefined();
	});

	it("holds it when the council read only what it builds on", async () => {
		await councilRead(trunk);

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours has read main..topic",
		);
	});

	it("holds it when a council read its commits in another repo", async () => {
		await councilRead(fix);

		expect(
			await councilFirst(
				exec,
				{ ...topic(), repo: "github:Shopify/other" },
				"proposed",
			),
		).toContain("isn't proposed");
	});

	it("holds it when its commits can't be read", async () => {
		await councilRead(fix);

		expect(
			await councilFirst(exec, { ...topic(), head: "nowhere" }, "proposed"),
		).toContain("Run review_ask council");
	});

	it("counts the head the backend names, though the checkout lacks it", async () => {
		await councilRead("f".repeat(40));

		expect(
			await councilFirst(
				exec,
				{ ...topic(), head: "nowhere", headCommit: "f".repeat(40) },
				"marked ready",
			),
		).toBeUndefined();
	});
});
