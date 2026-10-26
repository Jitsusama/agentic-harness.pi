/**
 * A replay carries on by itself through Markdown both sides only added to.
 *
 * Appended logs (a history, a decision list) conflicted on nearly every
 * replay: of 38 real rebases in one repository's reflogs, 17 of the 18 that
 * met a Markdown conflict met nothing but two additions at the same place,
 * and in 11 both sides had claimed the same entry number. Agents settled
 * each by hand the same way, keeping both, the landed side first, and moving
 * their own entry to the next free number. Run against real git, since what
 * conflicts, and how, is git's to say.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnExec } from "../../../lib/core/exec/index.ts";
import { createGitRebaser } from "../../../lib/core/work/rebase.ts";
import { disposeRepo, freshRepo, git } from "../../support/git-fixture.ts";

let repo: string;

beforeEach(async () => {
	repo = await freshRepo("rebase-appends");
});

afterEach(() => {
	disposeRepo(repo);
});

/** Commit these files, as they are given, on the branch checked out. */
async function commit(
	files: Record<string, string>,
	message: string,
): Promise<void> {
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(repo, name)), { recursive: true });
		writeFileSync(join(repo, name), content);
		await git(repo, "add", name);
	}
	await git(repo, "commit", "-qm", message);
}

/** A base, then `main` and `topic` each moving on from it; topic is left out. */
async function diverged(
	base: Record<string, string>,
	onMain: Record<string, string>,
	onTopic: Record<string, string>[],
): Promise<void> {
	await commit(base, "base");
	await git(repo, "checkout", "-q", "-b", "topic");
	for (const [index, files] of onTopic.entries()) {
		await commit(files, `topic ${index + 1}`);
	}
	await git(repo, "checkout", "-q", "main");
	await commit(onMain, "main moves");
	await git(repo, "checkout", "-q", "topic");
}

function rebaser() {
	return createGitRebaser({ exec: spawnExec() });
}

function read(path: string): string {
	return readFileSync(join(repo, path), "utf8");
}

const HISTORY = "# History\n\n## 1. First (2026-10-01)\n\nIt began.\n";

describe("a replay where both sides only added to a Markdown file", () => {
	it("keeps both additions, the landed one first, and finishes", async () => {
		await diverged(
			{ "docs/TESTING.md": "# Testing\n\n## Unit\n\nFast.\n" },
			{
				"docs/TESTING.md":
					"# Testing\n\n## Unit\n\nFast.\n\n## Live\n\nSlow.\n",
			},
			[
				{
					"docs/TESTING.md":
						"# Testing\n\n## Unit\n\nFast.\n\n## Fuzz\n\nRandom.\n",
				},
			],
		);

		const outcome = await rebaser().rebase(repo, "main");

		expect(outcome).toMatchObject({
			kind: "replayed",
			settled: [{ path: "docs/TESTING.md", hunks: 1, renumbered: [] }],
		});
		expect(read("docs/TESTING.md")).toBe(
			"# Testing\n\n## Unit\n\nFast.\n\n## Live\n\nSlow.\n\n## Fuzz\n\nRandom.\n",
		);
		expect(await git(repo, "status", "--porcelain")).toBe("");
	});

	it("moves the replayed entry to the next free number, citations and all", async () => {
		await diverged(
			{ "docs/HISTORY.md": HISTORY, "AGENTS.md": "# Agents\n" },
			{
				"docs/HISTORY.md": `${HISTORY}\n## 2. Landed (2026-10-02)\n\nSee §1.\n`,
			},
			[
				{
					"docs/HISTORY.md": `${HISTORY}\n## 2. Mine (2026-10-02; number may change at merge)\n\nUnlike §1, see §2 below.\n`,
					"AGENTS.md": "# Agents\n\nWhy: HISTORY §2.\n",
				},
			],
		);

		const outcome = await rebaser().rebase(repo, "main");

		expect(outcome).toMatchObject({
			kind: "replayed",
			settled: [
				{
					path: "docs/HISTORY.md",
					renumbered: [{ from: "HISTORY §2", to: "HISTORY §3" }],
					cited: ["AGENTS.md"],
				},
			],
		});
		expect(outcome).not.toHaveProperty("stale");
		expect(read("docs/HISTORY.md")).toBe(
			`${HISTORY}\n## 2. Landed (2026-10-02)\n\nSee §1.\n\n## 3. Mine (2026-10-02; number may change at merge)\n\nUnlike §1, see §3 below.\n`,
		);
		expect(read("AGENTS.md")).toBe("# Agents\n\nWhy: HISTORY §3.\n");
	});

	it("moves lettered decisions the same way, wherever they are cited", async () => {
		const decisions = "# Decisions\n\n- **D1 (2026-10-01)** Keep it simple.\n";
		await diverged(
			{ "AGENTS.md": decisions, "docs/CONTRACT.md": "# Contract\n" },
			{
				"AGENTS.md": `${decisions}\n- **D2 (2026-10-02)** Landed first.\n`,
			},
			[
				{
					"AGENTS.md": `${decisions}\n- **D2 (2026-10-02; number may change at merge; amends D1)** Mine.\n`,
					"docs/CONTRACT.md":
						"# Contract\n\nBounded since D2, not D12 or D21.\n",
				},
			],
		);

		const outcome = await rebaser().rebase(repo, "main");

		expect(outcome).toMatchObject({
			kind: "replayed",
			settled: [{ renumbered: [{ from: "D2", to: "D3" }] }],
		});
		expect(read("AGENTS.md")).toBe(
			`${decisions}\n- **D2 (2026-10-02)** Landed first.\n\n- **D3 (2026-10-02; number may change at merge; amends D1)** Mine.\n`,
		);
		expect(read("docs/CONTRACT.md")).toBe(
			"# Contract\n\nBounded since D3, not D12 or D21.\n",
		);
	});

	it("names a line an earlier commit added that still cites the old number", async () => {
		await diverged(
			{ "docs/HISTORY.md": HISTORY, "AGENTS.md": "# Agents\n" },
			{ "docs/HISTORY.md": `${HISTORY}\n## 2. Landed\n\nTheirs.\n` },
			[
				{ "AGENTS.md": "# Agents\n\nComing in HISTORY §2.\n" },
				{ "docs/HISTORY.md": `${HISTORY}\n## 2. Mine\n\nOurs.\n` },
			],
		);

		const outcome = await rebaser().rebase(repo, "main");

		expect(outcome).toMatchObject({
			kind: "replayed",
			settled: [{ renumbered: [{ from: "HISTORY §2", to: "HISTORY §3" }] }],
			stale: [{ path: "AGENTS.md", line: 3, cites: "HISTORY §2" }],
		});
	});

	it("carries a later commit through the conflict its own rewrite made", async () => {
		// Rewriting the first commit's citation changes the line the second
		// commit's change sits beside, so git no longer applies it, though it
		// disagrees with nothing anyone wrote. Found live on 22 October.
		await diverged(
			{ "docs/HISTORY.md": HISTORY, "AGENTS.md": "# Agents\n" },
			{ "docs/HISTORY.md": `${HISTORY}\n## 2. Landed\n\nTheirs.\n` },
			[
				{
					"docs/HISTORY.md": `${HISTORY}\n## 2. Mine\n\nOurs.\n`,
					"AGENTS.md": "# Agents\n\nSee HISTORY §2.\n",
				},
				{ "AGENTS.md": "# Agents\n\nSee HISTORY §2.\n\nAlso HISTORY §2.\n" },
			],
		);

		const outcome = await rebaser().rebase(repo, "main");

		expect(outcome).toMatchObject({
			kind: "replayed",
			settled: [{ path: "docs/HISTORY.md", cited: ["AGENTS.md"] }],
			recited: ["AGENTS.md"],
		});
		expect(outcome).not.toHaveProperty("stale");
		expect(read("AGENTS.md")).toBe(
			"# Agents\n\nSee HISTORY §3.\n\nAlso HISTORY §3.\n",
		);
		expect(await git(repo, "status", "--porcelain")).toBe("");
	});
});

describe("what is left for someone to settle", () => {
	it("leaves a file alone when any conflict in it changes what the base had", async () => {
		await diverged(
			{ "docs/HISTORY.md": HISTORY },
			{
				"docs/HISTORY.md": `${HISTORY.replace("It began.", "It began well.")}\n## 2. Landed\n`,
			},
			[
				{
					"docs/HISTORY.md": `${HISTORY.replace("It began.", "It began badly.")}\n## 2. Mine\n`,
				},
			],
		);

		const outcome = await rebaser().rebase(repo, "main");

		expect(outcome).toMatchObject({
			kind: "halted",
			conflicted: ["docs/HISTORY.md"],
		});
		expect(outcome).not.toHaveProperty("settled");
		expect(read("docs/HISTORY.md")).toContain("<<<<<<<");
	});

	it("settles the Markdown and halts on the code beside it", async () => {
		await diverged(
			{ "docs/HISTORY.md": HISTORY, "src/lib.rs": "fn a() {}\n" },
			{
				"docs/HISTORY.md": `${HISTORY}\n## 2. Landed\n`,
				"src/lib.rs": "fn a() { landed() }\n",
			},
			[
				{
					"docs/HISTORY.md": `${HISTORY}\n## 2. Mine\n`,
					"src/lib.rs": "fn a() { mine() }\n",
				},
			],
		);

		const outcome = await rebaser().rebase(repo, "main");

		expect(outcome).toMatchObject({
			kind: "halted",
			conflicted: ["src/lib.rs"],
			settled: [{ path: "docs/HISTORY.md" }],
		});
		writeFileSync(join(repo, "src/lib.rs"), "fn a() { landed(); mine() }\n");
		expect(await rebaser().resume(repo)).toMatchObject({ kind: "replayed" });
		expect(read("docs/HISTORY.md")).toContain("## 3. Mine");
	});

	it("never rewrites a citation inside a file still in conflict", async () => {
		// Rewriting it would mean staging it, which marks its conflict settled
		// and commits git's markers.
		await diverged(
			{ "docs/HISTORY.md": HISTORY, "src/lib.rs": "fn a() {}\n" },
			{
				"docs/HISTORY.md": `${HISTORY}\n## 2. Landed\n`,
				"src/lib.rs": "fn a() { landed() }\n",
			},
			[
				{
					"docs/HISTORY.md": `${HISTORY}\n## 2. Mine\n`,
					"src/lib.rs": "fn a() { mine() } // HISTORY \u00a72\n",
				},
			],
		);

		const outcome = await rebaser().rebase(repo, "main");

		expect(outcome).toMatchObject({
			kind: "halted",
			conflicted: ["src/lib.rs"],
		});
		expect(read("src/lib.rs")).toContain("<<<<<<<");
		expect(read("src/lib.rs")).toContain("// HISTORY \u00a72");
	});

	it("keeps a hand-settled file as it was settled when resuming", async () => {
		await diverged(
			{ "docs/HISTORY.md": HISTORY },
			{ "docs/HISTORY.md": `${HISTORY}\n## 2. Landed\n` },
			[{ "docs/HISTORY.md": `${HISTORY}\n## 2. Mine\n` }],
		);
		// Raw git halts and settles nothing, so the conflict is left for a person.
		await git(repo, "rebase", "main").catch(() => undefined);
		const chosen = `${HISTORY}\n## 2. Landed\n\n## 2b. Mine, as I chose\n`;
		writeFileSync(join(repo, "docs/HISTORY.md"), chosen);

		expect(await rebaser().resume(repo)).toMatchObject({ kind: "replayed" });
		expect(read("docs/HISTORY.md")).toBe(chosen);
	});
});
