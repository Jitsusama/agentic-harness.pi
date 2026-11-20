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
		// The earlier heads are read from reflogs, which a person's own
		// config could turn off.
		await git(repo, "config", "core.logAllRefUpdates", "true");
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

	/** Main takes a commit of its own, and the topic is rebased onto it. */
	async function rebasedOntoNewMain() {
		await git(repo, "switch", "-q", "main");
		writeFileSync(join(repo, "later"), "later\n");
		await git(repo, "add", "later");
		await git(repo, "commit", "-qm", "later");
		await git(repo, "switch", "-q", "topic");
		await git(repo, "rebase", "-q", "main");
		expect(
			await git(repo, "rev-parse", "HEAD"),
			"the rebase gave the head a new id",
		).not.toBe(fix);
	}

	it("keeps the council of a change a clean rebase moved", async () => {
		await councilRead(fix);
		await rebasedOntoNewMain();

		expect(await councilFirst(exec, topic(), "proposed")).toBeUndefined();
	});

	it("keeps the council read before a last fix across a clean rebase", async () => {
		await councilRead(first);
		await rebasedOntoNewMain();

		expect(await councilFirst(exec, topic(), "proposed")).toBeUndefined();
	});

	it("keeps the council when main changed the same file above the change", async () => {
		// The change appends to a file main then grows at its top, so the
		// rebase moves its hunk down and gives the file other blob ids.
		const lines = (from: number, to: number) =>
			Array.from({ length: to - from }, (_, at) => `line ${from + at}\n`).join(
				"",
			);
		await git(repo, "switch", "-q", "main");
		writeFileSync(join(repo, "shared"), lines(0, 10));
		await git(repo, "add", "shared");
		await git(repo, "commit", "-qm", "shared");
		await git(repo, "switch", "-q", "topic");
		await git(repo, "rebase", "-q", "main");
		writeFileSync(join(repo, "shared"), lines(0, 11));
		await git(repo, "commit", "-qam", "append");
		await councilRead(await git(repo, "rev-parse", "HEAD"));
		await git(repo, "switch", "-q", "main");
		writeFileSync(join(repo, "shared"), `top\nof\nfile\n${lines(0, 10)}`);
		await git(repo, "commit", "-qam", "grow");
		await git(repo, "switch", "-q", "topic");
		await git(repo, "rebase", "-q", "main");

		expect(await councilFirst(exec, topic(), "proposed")).toBeUndefined();
	});

	it("holds a rebased change with more on it than its council read", async () => {
		await councilRead(fix);
		await rebasedOntoNewMain();
		writeFileSync(join(repo, "two"), "two, said otherwise\n");
		await git(repo, "commit", "-qam", "otherwise");

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("lends a rebase nothing a branch cut from reviewed work couldn't claim", async () => {
		// `first` went up as another branch and its council read it; this
		// one adds `fix`, which nobody read, and is then rebased.
		await git(repo, "update-ref", "refs/remotes/origin/reviewed", first);
		await councilRead(first);
		await rebasedOntoNewMain();

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("holds a binary file whose content changed though its diff's words didn't", async () => {
		const binary = (byte: number) =>
			writeFileSync(join(repo, "blob.bin"), Buffer.from([0, byte, 0, 255]));
		binary(1);
		await git(repo, "add", "blob.bin");
		await git(repo, "commit", "-qm", "blob");
		await councilRead(await git(repo, "rev-parse", "HEAD"));
		await rebasedOntoNewMain();
		binary(2);
		await git(repo, "commit", "-qam", "other bytes");

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("holds text whose bytes changed where they aren't UTF-8", async () => {
		const latin = (byte: number) =>
			writeFileSync(join(repo, "latin"), Buffer.from([0x63, 0x61, byte, 0x0a]));
		latin(0xe9);
		await git(repo, "add", "latin");
		await git(repo, "commit", "-qm", "latin");
		await councilRead(await git(repo, "rev-parse", "HEAD"));
		await git(repo, "reset", "-q", "--hard", "HEAD~1");
		latin(0xe8);
		await git(repo, "add", "latin");
		await git(repo, "commit", "-qm", "latin, otherwise");

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("holds the same edit made in another function", async () => {
		// Bodies alike and long enough that a hunk in either reads the same
		// but for the function its header names.
		const lines = Array.from({ length: 11 }, (_, at) => `\tline${at};\n`);
		const body = lines.join("");
		const edited = body.replace("line5;", "LINE5;");
		const file = (a: string, b: string) =>
			writeFileSync(
				join(repo, "code"),
				`function a() {\n${a}}\nfunction b() {\n${b}}\n`,
			);
		await git(repo, "switch", "-q", "main");
		file(body, body);
		await git(repo, "add", "code");
		await git(repo, "commit", "-qm", "code");
		await git(repo, "switch", "-q", "topic");
		await git(repo, "rebase", "-q", "main");
		file(edited, body);
		await git(repo, "commit", "-qam", "in a");
		await councilRead(await git(repo, "rev-parse", "HEAD"));
		await git(repo, "reset", "-q", "--hard", "HEAD~1");
		file(body, edited);
		await git(repo, "commit", "-qam", "in b");

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("finds the head before a rebase in the pushed branch's reflog", async () => {
		// Pushed before the rebase and again after it, from a checkout whose
		// own branch remembers nothing of its past.
		await git(repo, "update-ref", "refs/remotes/origin/topic", fix);
		await councilRead(fix);
		await rebasedOntoNewMain();
		await git(
			repo,
			"update-ref",
			"refs/remotes/origin/topic",
			await git(repo, "rev-parse", "HEAD"),
		);
		await git(repo, "reflog", "expire", "--expire=now", "refs/heads/topic");

		expect(await councilFirst(exec, topic(), "proposed")).toBeUndefined();
	});

	it("holds a clean rebase of a change no council read", async () => {
		await councilRead(trunk);
		await rebasedOntoNewMain();

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
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
