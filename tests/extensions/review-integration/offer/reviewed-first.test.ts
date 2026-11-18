/**
 * Whether our own council has read a change, judged from the change's
 * commits in its checkout and the rounds held on disk.
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

/** Git in `cwd`, reading `input` on its standard input. */
function gitFed(cwd: string, args: string[], input: string): Promise<string> {
	return new Promise((done, fail) => {
		const child = execFile("git", ["-C", cwd, ...args], (error, stdout) =>
			error ? fail(error) : done(String(stdout)),
		);
		child.stdin?.end(input);
	});
}

/** A remote branch for each name, each a commit of its own on `parent`. */
function branchesOn(cwd: string, parent: string, names: readonly string[]) {
	const stream = names
		.map((name) => {
			const message = `${name}\n`;
			return [
				`commit refs/remotes/origin/${name}`,
				"committer Test <test@example.com> 1700000000 +0000",
				`data ${message.length}`,
				message,
				`from ${parent}`,
				"",
			].join("\n");
		})
		.join("\n");
	return gitFed(cwd, ["fast-import", "--quiet"], stream);
}

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
		// Every repo here is a copy of one pristine repo, so commits made in
		// the same second get the same hashes from test to test; an earlier
		// test's council would read as this one's.
		rmSync(runDir(), { recursive: true, force: true });
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

	it("says its commits can't be read, rather than that no council read them", async () => {
		await councilRead(fix);

		const said = await councilFirst(
			exec,
			{ ...topic(), head: "nowhere" },
			"proposed",
		);

		expect(said).toContain("can't be read");
		expect(said).not.toContain("Run review_ask council");
	});

	it("reads no name git would take for an option", async () => {
		await councilRead(fix);

		expect(
			await councilFirst(exec, { ...topic(), head: "--all" }, "proposed"),
		).toContain(`"--all" isn't a ref`);
	});

	it("judges the pushed head, which is what goes up", async () => {
		// Pushed at `first`, with `fix` only on the local branch: the
		// council read `fix`, which nobody proposing this would see.
		await councilRead(fix);
		await git(repo, "update-ref", "refs/remotes/origin/topic", first);

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("leaves out what the remote's base has taken, which the local one may trail", async () => {
		// The local main sits at the trunk; the remote's has taken `first`.
		// A council of `first` read only what the change builds on.
		await councilRead(first);
		await git(repo, "update-ref", "refs/remotes/origin/main", first);

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("holds a change below a stack whose council read only the top change", async () => {
		await git(repo, "branch", "lower", first);
		await councilRead(fix);

		expect(
			await councilFirst(exec, { ...topic(), head: "lower" }, "proposed"),
		).toContain("No council of ours");
	});

	it("holds a branch cut from reviewed work, whose own commits nobody read", async () => {
		// `first` went up as another branch and its council read it; this
		// one adds `fix` on top and is proposed onto main by itself.
		await git(repo, "update-ref", "refs/remotes/origin/reviewed", first);
		await councilRead(first);

		const said = await councilFirst(exec, topic(), "proposed");

		expect(said).toContain("isn't proposed yet");
		expect(said).toContain("commits reviewed also hold without its head");
		expect(said).toContain("restack them onto its head");
	});

	it("counts what its own branch on another remote holds as its own", async () => {
		// Pushed to a fork before the fix, with the fix only local.
		await git(repo, "update-ref", "refs/remotes/fork/topic", first);
		await councilRead(first);

		expect(await councilFirst(exec, topic(), "proposed")).toBeUndefined();
	});

	it("leaves out reviewed work however many branches the clone has", async () => {
		// Five hundred branches off `first` hold none of what the council
		// read, and sort first; the one holding `fix` comes after them, so
		// only a second batch of branches leaves it out.
		writeFileSync(join(repo, "three"), "three\n");
		await git(repo, "add", "three");
		await git(repo, "commit", "-qm", "three");
		const stale = Array.from(
			{ length: 500 },
			(_, at) => `stale-${String(at).padStart(3, "0")}`,
		);
		await branchesOn(repo, first, stale);
		await git(repo, "update-ref", "refs/remotes/origin/zz-reviewed", fix);
		await councilRead(fix);

		const said = await councilFirst(exec, topic(), "proposed");

		expect(said).toContain("stale-000, stale-001, stale-002 and others");
	});

	it("lets a reviewed change through beside hundreds of unrelated branches", async () => {
		// Branches off the trunk hold nothing the change does.
		const beside = Array.from({ length: 600 }, (_, at) => `beside-${at}`);
		await branchesOn(repo, trunk, beside);
		await councilRead(first);

		expect(await councilFirst(exec, topic(), "proposed")).toBeUndefined();
	});

	it("keeps a lower change's commits its own, though the branch above holds them", async () => {
		await git(repo, "branch", "lower", first);
		await git(repo, "update-ref", "refs/remotes/origin/lower", first);
		await git(repo, "update-ref", "refs/remotes/origin/topic", fix);
		await councilRead(first);

		expect(
			await councilFirst(exec, { ...topic(), head: "lower" }, "proposed"),
		).toBeUndefined();
	});

	it("says the range can't be read when the head the backend names has no council", async () => {
		const said = await councilFirst(
			exec,
			{ ...topic(), head: "nowhere", headCommit: "e".repeat(40) },
			"marked ready",
		);

		expect(said).toContain("can't be read");
		expect(said).not.toContain("No council of ours");
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
