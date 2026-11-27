/**
 * Whether our own council has read a change, judged from the change's
 * commits in its checkout and the rounds held on disk.
 *
 * Long because every case moves one repository's branches through the
 * same fixture and helpers, held in the suite's closure: split, each half
 * would carry its own copy of them, or a module of moves shared by one
 * suite alone.
 */

import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
	await councilOn(range, witness, over);
}

/** A pull request of the repo, numbered `id`. */
function pullRequest(id: string): ChangeRef {
	return {
		provider: "github",
		repo: { key: REPO },
		id,
		label: `Shopify/world#${id}`,
	};
}

/** A finished council whose reviewers read `witness`, held against `change`. */
async function councilOn(
	change: ChangeRef,
	witness: string,
	over: Partial<AskRun> = {},
) {
	await createRunStore(runDir()).record(change, {
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

	it("keeps the council across a clean rebase and a fix made after it", async () => {
		await councilRead(fix);
		await rebasedOntoNewMain();
		writeFileSync(join(repo, "two"), "two, said otherwise\n");
		await git(repo, "commit", "-qam", "otherwise");

		expect(await councilFirst(exec, topic(), "proposed")).toBeUndefined();
	});

	it("keeps the council when main moves on again after the rebase", async () => {
		await councilRead(fix);
		await rebasedOntoNewMain();
		await git(repo, "switch", "-q", "main");
		writeFileSync(join(repo, "later still"), "later still\n");
		await git(repo, "add", "later still");
		await git(repo, "commit", "-qm", "later still");
		await git(repo, "switch", "-q", "topic");

		expect(await councilFirst(exec, topic(), "proposed")).toBeUndefined();
	});

	it("holds a rebased change whose reviewed commit was then rewritten", async () => {
		await councilRead(fix);
		await rebasedOntoNewMain();
		await git(repo, "reset", "-q", "--hard", "HEAD~1");
		writeFileSync(join(repo, "two"), "two, said otherwise\n");
		await git(repo, "add", "two");
		await git(repo, "commit", "-qm", "two, otherwise");

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("lends an upper branch nothing of a lower one's council across a restack", async () => {
		// `first` went up as the branch below and its council read it; this
		// one adds `fix`, which nobody read. Both are restacked onto a new
		// main, so no pushed branch holds `first` itself any more.
		await git(repo, "branch", "lower", first);
		await git(repo, "update-ref", "refs/remotes/origin/lower", first);
		await councilRead(first);
		await git(repo, "switch", "-q", "main");
		writeFileSync(join(repo, "later"), "later\n");
		await git(repo, "add", "later");
		await git(repo, "commit", "-qm", "later");
		await git(repo, "switch", "-q", "lower");
		await git(repo, "rebase", "-q", "main");
		await git(
			repo,
			"update-ref",
			"refs/remotes/origin/lower",
			await git(repo, "rev-parse", "HEAD"),
		);
		await git(repo, "switch", "-q", "topic");
		await git(repo, "rebase", "-q", "lower");

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	/**
	 * Main adds its own `two`, so rebasing the topic stops at `fix`; it
	 * is settled with what `settle` gives for the file, from main's head.
	 */
	async function rebasedThroughAConflict(
		settle: (onto: string) => Promise<string>,
	) {
		await git(repo, "switch", "-q", "main");
		writeFileSync(join(repo, "two"), "two on main\n");
		await git(repo, "add", "two");
		await git(repo, "commit", "-qm", "main's two");
		const onto = await git(repo, "rev-parse", "HEAD");
		await git(repo, "switch", "-q", "topic");
		const stopped = await exec("git", ["-C", repo, "rebase", "-q", "main"]);
		expect(stopped.code, "the rebase stopped at the conflict").not.toBe(0);
		writeFileSync(join(repo, "two"), await settle(onto));
		await git(repo, "add", "two");
		const went = await exec("git", [
			"-C",
			repo,
			"-c",
			"core.editor=true",
			"rebase",
			"--continue",
		]);
		expect(went.code, went.stderr).toBe(0);
	}

	/** `two` as git's replay of the topic onto `onto` leaves it. */
	async function replayedTwo(onto: string): Promise<string> {
		const merged = await exec("git", [
			"-C",
			repo,
			"merge-tree",
			"--write-tree",
			"--no-messages",
			`--merge-base=${trunk}`,
			onto,
			fix,
		]);
		const tree = merged.stdout.split("\n")[0] ?? "";
		return (await exec("git", ["-C", repo, "show", `${tree}:two`])).stdout;
	}

	it("holds a rebase settled by keeping the conflict git left", async () => {
		await councilRead(fix);
		await rebasedThroughAConflict(async (onto) => {
			const left = await replayedTwo(onto);
			expect(left, "git left the conflict in the file").toContain("<<<<<<<");
			return left;
		});

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("holds a rebase whose conflict a merge driver in the checkout's files settled", async () => {
		await councilRead(fix);
		await rebasedThroughAConflict(async (onto) => {
			writeFileSync(join(repo, ".gitattributes"), "two merge=union\n");
			const united = await replayedTwo(onto);
			expect(united, "the driver settled the conflict").not.toContain(
				"<<<<<<<",
			);
			return united;
		});

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("holds a rebase whose conflict the checkout's default merge driver settled", async () => {
		await councilRead(fix);
		await rebasedThroughAConflict(async (onto) => {
			await git(repo, "config", "merge.default", "union");
			const united = await replayedTwo(onto);
			expect(united, "the driver settled the conflict").not.toContain(
				"<<<<<<<",
			);
			return united;
		});

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	/** The checkout's own attributes, which git reads whatever it is told. */
	async function ownAttributes(text: string) {
		const own = join(
			repo,
			await git(repo, "rev-parse", "--git-path", "info/attributes"),
		);
		mkdirSync(dirname(own), { recursive: true });
		writeFileSync(own, text);
	}

	it("holds a rebase whose conflict a merge driver the checkout names settled", async () => {
		await councilRead(fix);
		await rebasedThroughAConflict(async (onto) => {
			await ownAttributes("* merge=union\n");
			const united = await replayedTwo(onto);
			expect(united, "the driver settled the conflict").not.toContain(
				"<<<<<<<",
			);
			return united;
		});

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("keeps a clean rebase's council in a checkout naming merge drivers of its own", async () => {
		await councilRead(fix);
		await rebasedOntoNewMain();
		await ownAttributes("* merge=union\n");

		expect(await councilFirst(exec, topic(), "proposed")).toBeUndefined();
	});

	it("lends nothing to a branch made at reviewed work and rebased at once", async () => {
		// `fix` went up as the topic and its council read it; `cut` is made
		// there, rebased before it holds anything of its own, then given
		// `three`, which nobody read. Unrebased, the topic's pushed branch
		// would hold its commits without its head and keep them the topic's.
		await git(repo, "update-ref", "refs/remotes/origin/topic", fix);
		await councilRead(fix);
		await git(repo, "switch", "-q", "main");
		writeFileSync(join(repo, "later"), "later\n");
		await git(repo, "add", "later");
		await git(repo, "commit", "-qm", "later");
		await git(repo, "switch", "-qc", "cut", "topic");
		await git(repo, "rebase", "-q", "main");
		writeFileSync(join(repo, "three"), "three\n");
		await git(repo, "add", "three");
		await git(repo, "commit", "-qm", "three");

		expect(
			await councilFirst(exec, { ...topic(), head: "cut" }, "proposed"),
		).toContain("No council of ours");
	});

	/**
	 * `fix` goes up as the topic and its council reads it; `cut` is made
	 * on the trunk and `bring` moves it to `fix`, then main moves on, `cut`
	 * is rebased onto it and given `three`, which nobody read.
	 */
	async function broughtToReviewedWork(bring: () => Promise<unknown>) {
		await git(repo, "update-ref", "refs/remotes/origin/topic", fix);
		await councilRead(fix);
		await git(repo, "switch", "-qc", "cut", trunk);
		await bring();
		await git(repo, "switch", "-q", "main");
		writeFileSync(join(repo, "later"), "later\n");
		await git(repo, "add", "later");
		await git(repo, "commit", "-qm", "later");
		await git(repo, "switch", "-q", "cut");
		await git(repo, "rebase", "-q", "main");
		writeFileSync(join(repo, "three"), "three\n");
		await git(repo, "add", "three");
		await git(repo, "commit", "-qm", "three");
	}

	it("lends nothing to a branch reset onto reviewed work, then rebased", async () => {
		await broughtToReviewedWork(() =>
			git(repo, "reset", "-q", "--hard", "topic"),
		);

		expect(
			await councilFirst(exec, { ...topic(), head: "cut" }, "proposed"),
		).toContain("No council of ours");
	});

	it("lends nothing to a branch fast-forwarded to reviewed work, then rebased", async () => {
		await broughtToReviewedWork(() =>
			git(repo, "merge", "-q", "--ff-only", "topic"),
		);

		expect(
			await councilFirst(exec, { ...topic(), head: "cut" }, "proposed"),
		).toContain("No council of ours");
	});

	it("lends nothing to a branch rebased onto reviewed work it held none of", async () => {
		// A rebase with nothing to replay only fast-forwards.
		await broughtToReviewedWork(() => git(repo, "rebase", "-q", "topic"));

		expect(
			await councilFirst(exec, { ...topic(), head: "cut" }, "proposed"),
		).toContain("No council of ours");
	});

	it("lends nothing to a copy of a reviewed branch, though it copies the reflog", async () => {
		await git(repo, "update-ref", "refs/remotes/origin/topic", fix);
		await councilRead(fix);
		await git(repo, "branch", "-c", "topic", "copy");
		await git(repo, "switch", "-q", "main");
		writeFileSync(join(repo, "later"), "later\n");
		await git(repo, "add", "later");
		await git(repo, "commit", "-qm", "later");
		await git(repo, "switch", "-q", "copy");
		await git(repo, "rebase", "-q", "main");
		writeFileSync(join(repo, "three"), "three\n");
		await git(repo, "add", "three");
		await git(repo, "commit", "-qm", "three");

		expect(
			await councilFirst(exec, { ...topic(), head: "copy" }, "proposed"),
		).toContain("No council of ours");
	});

	it("keeps a renamed branch's council across a clean rebase", async () => {
		await councilRead(fix);
		await git(repo, "branch", "-m", "topic", "renamed");
		await git(repo, "switch", "-q", "main");
		writeFileSync(join(repo, "later"), "later\n");
		await git(repo, "add", "later");
		await git(repo, "commit", "-qm", "later");
		await git(repo, "switch", "-q", "renamed");
		await git(repo, "rebase", "-q", "main");

		expect(
			await councilFirst(exec, { ...topic(), head: "renamed" }, "proposed"),
		).toBeUndefined();
	});

	/** The pull request the topic went up as, and one beside it. */
	const wentUpAs = pullRequest("7017");
	const beside = pullRequest("7016");

	/**
	 * The topic, pushed at `made`, is checked out afresh from its remote
	 * there, as another session's tree takes it, and brought to `fix`,
	 * the head pushed since, when `made` is below it. Then main moves on,
	 * and the topic is rebased onto it and pushed again.
	 */
	async function checkedOutAfresh(made: string) {
		await git(repo, "update-ref", "refs/remotes/origin/topic", made);
		await git(repo, "switch", "-q", "main");
		await git(repo, "branch", "-D", "topic");
		await git(repo, "branch", "topic", "origin/topic");
		await git(repo, "update-ref", "refs/remotes/origin/topic", fix);
		await git(repo, "switch", "-q", "topic");
		if (made !== fix)
			await git(repo, "merge", "-q", "--ff-only", "origin/topic");
		await rebasedOntoNewMain();
		await git(
			repo,
			"update-ref",
			"refs/remotes/origin/topic",
			await git(repo, "rev-parse", "HEAD"),
		);
	}

	/** The topic, judged as the pull request it went up as. */
	const asWentUp = () => ({ ...topic(), change: wentUpAs });

	it("keeps the change's council when its branch is made afresh at the head it read, then rebased", async () => {
		await councilOn(wentUpAs, fix);
		await checkedOutAfresh(fix);

		expect(
			await councilFirst(exec, asWentUp(), "marked ready"),
		).toBeUndefined();
	});

	it("lends another change's council nothing at the head a branch was made at afresh", async () => {
		await councilOn(beside, fix);
		await checkedOutAfresh(fix);

		expect(await councilFirst(exec, asWentUp(), "marked ready")).toContain(
			"No council of ours",
		);
	});

	it("lends nothing at the head a branch was made at afresh when no change is named", async () => {
		// Proposing names no hosted change, so no council is this change's.
		await councilOn(wentUpAs, fix);
		await checkedOutAfresh(fix);

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("keeps the change's council at the head a fresh branch was fast-forwarded to", async () => {
		await councilOn(wentUpAs, fix);
		await checkedOutAfresh(first);

		expect(
			await councilFirst(exec, asWentUp(), "marked ready"),
		).toBeUndefined();
	});

	it("lends another change's council nothing at the head a fresh branch was fast-forwarded to", async () => {
		await councilOn(beside, fix);
		await checkedOutAfresh(first);

		expect(await councilFirst(exec, asWentUp(), "marked ready")).toContain(
			"No council of ours",
		);
	});

	it("lends the change's council nothing below the head a fresh branch was fast-forwarded to", async () => {
		// `first` is where the branch was made, and its replay gives the tree
		// of the rebased commit below the head, but it sits under `fix`,
		// which the branch was brought to.
		await councilOn(wentUpAs, first);
		await checkedOutAfresh(first);

		expect(await councilFirst(exec, asWentUp(), "marked ready")).toContain(
			"No council of ours",
		);
	});

	it("holds a rebase whose conflict the person's global merge driver settled", async () => {
		const global = join(repo, "..", `${repo.split("/").at(-1)}.gitconfig`);
		writeFileSync(global, "[merge]\n\tdefault = union\n");
		const was = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = global;
		try {
			await councilRead(fix);
			await git(repo, "switch", "-q", "main");
			writeFileSync(join(repo, "two"), "two on main\n");
			await git(repo, "add", "two");
			await git(repo, "commit", "-qm", "main's two");
			await git(repo, "switch", "-q", "topic");
			const went = await exec("git", ["-C", repo, "rebase", "-q", "main"]);
			expect(went.code, "the global driver settled the rebase").toBe(0);

			expect(await councilFirst(exec, topic(), "proposed")).toContain(
				"No council of ours",
			);
		} finally {
			if (was === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = was;
			rmSync(global, { force: true });
		}
	});

	it("holds a rebase whose conflict a merge driver the change commits settled", async () => {
		writeFileSync(join(repo, ".gitattributes"), "* merge=union\n");
		await git(repo, "add", ".gitattributes");
		await git(repo, "commit", "-qm", "attributes");
		writeFileSync(join(repo, "three"), "three on the topic\n");
		await git(repo, "add", "three");
		await git(repo, "commit", "-qm", "three");
		await councilRead(await git(repo, "rev-parse", "HEAD"));
		await git(repo, "switch", "-q", "main");
		writeFileSync(join(repo, "three"), "three on main\n");
		await git(repo, "add", "three");
		await git(repo, "commit", "-qm", "main's three");
		await git(repo, "switch", "-q", "topic");
		const went = await exec("git", ["-C", repo, "rebase", "-q", "main"]);
		expect(went.code, "the committed driver settled the rebase").toBe(0);

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("keeps a restacked upper branch's own council", async () => {
		// The topic sits on `lower`, which holds `first`; its council read
		// `fix`, and both are restacked onto a new main.
		await git(repo, "branch", "lower", first);
		await git(repo, "update-ref", "refs/remotes/origin/lower", first);
		await git(repo, "update-ref", "refs/remotes/origin/topic", fix);
		await councilRead(fix);
		await git(repo, "switch", "-q", "main");
		writeFileSync(join(repo, "later"), "later\n");
		await git(repo, "add", "later");
		await git(repo, "commit", "-qm", "later");
		await git(repo, "switch", "-q", "lower");
		await git(repo, "rebase", "-q", "main");
		const restacked = await git(repo, "rev-parse", "HEAD");
		await git(repo, "update-ref", "refs/remotes/origin/lower", restacked);
		await git(repo, "switch", "-q", "topic");
		await git(repo, "rebase", "-q", "--onto", "lower", first);
		// Pushed, as a restack is, so the head judged is the rebased one.
		const pushed = await git(repo, "rev-parse", "HEAD");
		await git(repo, "update-ref", "refs/remotes/origin/topic", pushed);

		expect(
			await councilFirst(exec, { ...topic(), base: "lower" }, "proposed"),
		).toBeUndefined();
	});

	it("keeps a lower branch's council when it is rebased under one not yet restacked", async () => {
		// `lower` is made on the trunk and holds `first`, which its council
		// read; the topic above it still holds the old `first`.
		await git(repo, "branch", "lower", trunk);
		// Its reflog says `first` was committed there, as committing it would.
		await git(
			repo,
			"update-ref",
			"-m",
			"commit: one",
			"refs/heads/lower",
			first,
		);
		await git(repo, "update-ref", "refs/remotes/origin/lower", first);
		await git(repo, "update-ref", "refs/remotes/origin/topic", fix);
		await councilRead(first);
		await git(repo, "switch", "-q", "main");
		writeFileSync(join(repo, "later"), "later\n");
		await git(repo, "add", "later");
		await git(repo, "commit", "-qm", "later");
		await git(repo, "switch", "-q", "lower");
		await git(repo, "rebase", "-q", "main");
		// Pushed, so the head judged is the rebased one.
		const pushed = await git(repo, "rev-parse", "HEAD");
		await git(repo, "update-ref", "refs/remotes/origin/lower", pushed);

		expect(
			await councilFirst(exec, { ...topic(), head: "lower" }, "proposed"),
		).toBeUndefined();
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

	it("holds a rebase whose binary file's bytes differ from what was read", async () => {
		const binary = (byte: number) =>
			writeFileSync(join(repo, "blob.bin"), Buffer.from([0, byte, 0, 255]));
		binary(1);
		await git(repo, "add", "blob.bin");
		await git(repo, "commit", "-qm", "blob");
		await councilRead(await git(repo, "rev-parse", "HEAD"));
		await rebasedOntoNewMain();
		await git(repo, "reset", "-q", "--hard", "HEAD~1");
		binary(2);
		await git(repo, "add", "blob.bin");
		await git(repo, "commit", "-qm", "blob, other bytes");

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("holds a rewrite whose text differs from what was read only in bytes that aren't UTF-8", async () => {
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

	it("holds a rewrite making the reviewed edit in another function", async () => {
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

	/** The topic pushed before the rebase and again after it. */
	async function pushedAcrossTheRebase() {
		await git(repo, "update-ref", "refs/remotes/origin/topic", fix);
		await councilRead(fix);
		await rebasedOntoNewMain();
		await git(
			repo,
			"update-ref",
			"refs/remotes/origin/topic",
			await git(repo, "rev-parse", "HEAD"),
		);
	}

	/**
	 * How long the test making more commits than the reflog is asked for
	 * may take: 31 commits a process each, which a loaded machine has
	 * taken past the usual 30 s.
	 */
	const MANY_MOVES_MS = 120_000;

	it(
		"finds the head before a rebase in the pushed branch's reflog",
		async () => {
			// The branch moved more often since than its own heads are asked
			// for, so only the pushed branch's reflog recalls the reviewed head.
			await pushedAcrossTheRebase();
			for (let moved = 0; moved <= 30; moved++)
				await git(
					repo,
					"commit",
					"-q",
					"--allow-empty",
					"-m",
					`again ${moved}`,
				);
			await git(
				repo,
				"update-ref",
				"refs/remotes/origin/topic",
				await git(repo, "rev-parse", "HEAD"),
			);

			expect(await councilFirst(exec, topic(), "proposed")).toBeUndefined();
		},
		MANY_MOVES_MS,
	);

	it("lends nothing of a pushed head the branch here never held", async () => {
		// `fix` went up under the branch's name and its council read it;
		// the branch here was made afresh and its own commits copy it.
		await git(repo, "update-ref", "refs/remotes/origin/topic", fix);
		await councilRead(fix);
		await git(repo, "switch", "-q", "main");
		await git(repo, "branch", "-D", "topic");
		await git(repo, "switch", "-q", "-c", "topic", trunk);
		await git(repo, "cherry-pick", "-x", "--allow-empty", first, fix);
		expect(
			await git(repo, "rev-parse", "HEAD"),
			"the copies are commits of their own",
		).not.toBe(fix);
		await rebasedOntoNewMain();
		await git(
			repo,
			"update-ref",
			"refs/remotes/origin/topic",
			await git(repo, "rev-parse", "HEAD"),
		);

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
	});

	it("lends nothing once the branch's reflog no longer says where it was made", async () => {
		await pushedAcrossTheRebase();
		await git(repo, "reflog", "expire", "--expire=now", "refs/heads/topic");

		expect(await councilFirst(exec, topic(), "proposed")).toContain(
			"No council of ours",
		);
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
