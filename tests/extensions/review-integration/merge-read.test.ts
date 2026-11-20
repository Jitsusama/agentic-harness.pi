/**
 * A merge waits for our own review to have read its head, or an earlier
 * commit of the same change with the same patch. Driven over a real git
 * repo, since a patch's sameness is git's to say, with the rounds held
 * by a stand-in ledger.
 */

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	readRoundsFrom,
	unreadHead,
} from "../../../extensions/review-integration/merge-read.ts";
import type { Exec } from "../../../lib/core/exec/index.ts";
import type {
	AskRun,
	ChangeRef,
	RunStore,
} from "../../../lib/core/review/index.ts";
import { OFF } from "../../../lib/internal/fence/fence-stage.ts";
import { SANDBOX_VARIABLE } from "../../../lib/internal/sandbox/sandbox.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

const change: ChangeRef = {
	provider: "github",
	repo: { key: "github:Jitsusama/core.nix" },
	id: "5776",
	label: "Jitsusama/core.nix#5776",
};

/** Git asked for real, answering a failure as an exit code rather than a throw. */
const exec: Exec = (command, args) =>
	new Promise((resolve) => {
		execFile(command, args, (error, stdout, stderr) => {
			const code = error
				? typeof error.code === "number"
					? error.code
					: 1
				: 0;
			resolve({ code, stdout, stderr });
		});
	});

/** A ledger whose finished rounds read `read`, all of them this change's. */
function ledgerReading(read: readonly string[]): RunStore {
	const round = { id: "council-1" } as AskRun;
	return {
		witnessed: async (_repo: string, commits: ReadonlySet<string>) =>
			read.some((sha) => commits.has(sha)) ? round : undefined,
		readBy: async () => [...read],
	} as unknown as RunStore;
}

/** Commit `text` into `file` in `repo`, and say the commit. */
async function commit(
	repo: string,
	file: string,
	text: string,
): Promise<string> {
	writeFileSync(join(repo, file), text);
	await git(repo, "add", file);
	await git(repo, "commit", "-qm", `write ${file}`);
	return git(repo, "rev-parse", "HEAD");
}

let repo: string;

beforeEach(async () => {
	// Unfenced, whatever runs the tests: inside the fence git is refused
	// in a repo that isn't a cut tree, which this fixture never is.
	vi.stubEnv(SANDBOX_VARIABLE, OFF);
	repo = await freshRepo("merge-read");
	await git(repo, "checkout", "-qb", "topic");
});

afterEach(() => {
	readRoundsFrom(undefined);
	vi.unstubAllEnvs();
	disposeRepo(repo);
});

const merging = (head: string) => ({
	change,
	head,
	base: "main",
	checkout: repo,
});

describe("merging only what a review read", () => {
	it("lets through a head a round read", async () => {
		const head = await commit(repo, "a.txt", "one\n");
		readRoundsFrom(ledgerReading([head]));

		expect(await unreadHead(exec, merging(head))).toBeUndefined();
	});

	it("refuses a head no round read, naming it", async () => {
		const head = await commit(repo, "a.txt", "one\n");
		readRoundsFrom(ledgerReading([]));

		expect(await unreadHead(exec, merging(head))).toContain(
			`No review round of ours read ${head.slice(0, 12)}`,
		);
	});

	it("lets through a clean rebase of a commit a round read", async () => {
		const read = await commit(repo, "a.txt", "one\n");
		await git(repo, "checkout", "-q", "main");
		await commit(repo, "b.txt", "main moved\n");
		await git(repo, "checkout", "-q", "topic");
		await git(repo, "rebase", "-q", "main");
		const head = await git(repo, "rev-parse", "HEAD");
		readRoundsFrom(ledgerReading([read]));

		expect(head).not.toBe(read);
		expect(await unreadHead(exec, merging(head))).toBeUndefined();
	});

	it("refuses a fix pushed after the round that read the change", async () => {
		const read = await commit(repo, "a.txt", "one\n");
		const head = await commit(repo, "a.txt", "one\nand a fix\n");
		readRoundsFrom(ledgerReading([read]));

		expect(await unreadHead(exec, merging(head))).toContain(
			"nor an earlier commit of Jitsusama/core.nix#5776 with the same patch",
		);
	});

	it("refuses an edit of a read commit's whitespace alone", async () => {
		const read = await commit(repo, "a.txt", "one\n");
		await git(repo, "checkout", "-q", "main");
		await git(repo, "checkout", "-qb", "spaced");
		const head = await commit(repo, "a.txt", "  one\n");
		readRoundsFrom(ledgerReading([read]));

		expect(await unreadHead(exec, merging(head))).toContain("was not merged");
	});

	it("passes over what a ledger names that isn't a commit", async () => {
		const head = await commit(repo, "a.txt", "one\n");
		readRoundsFrom(ledgerReading(["--output=/tmp/x", "zzz"]));

		expect(await unreadHead(exec, merging(head))).toContain("was not merged");
	});
});
