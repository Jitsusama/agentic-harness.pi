/**
 * What a replay settled by itself is said in the work tool's answer.
 *
 * Since core 0.15.0 a replay through Markdown both sides only added to
 * carries on by itself: it keeps both additions, moves the replayed
 * entries to free numbers and rewrites their citations. That changes
 * files nobody edited by hand, so the answer must name each one and
 * every number moved, and name the lines the branch added that still
 * cite a moved number, since those are the one thing left to fix.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type TreeClaims,
	WORK_TREE_CLAIMS,
} from "@jitsusama/agentic-harness.core/work";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetTreeBroker } from "../../extensions/work-integration/broker.ts";
import workIntegration from "../../extensions/work-integration/index.ts";
import { settlingLines } from "../../extensions/work-integration/tools/settling.ts";
import { disposeRepo, freshRepo, git } from "../support/git-fixture.ts";
import {
	activateWith,
	HEADLESS,
	toolNamed,
} from "./support/review-extension.ts";

describe("the lines a replay's settling is said in", () => {
	it("names each file, how many places, and every number moved", () => {
		const lines = settlingLines({
			settled: [
				{
					path: "docs/HISTORY.md",
					hunks: 1,
					renumbered: [{ from: "HISTORY §2", to: "HISTORY §3" }],
					cited: ["AGENTS.md"],
				},
			],
		});

		expect(lines.join("\n")).toContain(
			"docs/HISTORY.md: both sides only added, at 1 place",
		);
		expect(lines.join("\n")).toContain(
			"HISTORY §2 is now HISTORY §3, and so are its citations.",
		);
		expect(lines.join("\n")).toContain("Citations rewritten in AGENTS.md too.");
	});

	it("names each stale citation by file and line, to fix in a commit", () => {
		const said = settlingLines({
			stale: [{ path: "AGENTS.md", line: 3, cites: "HISTORY §2" }],
		}).join("\n");

		expect(said).toContain("Fix them in a commit of their own");
		expect(said).toContain("AGENTS.md:3 cites HISTORY §2");
	});

	it("says nothing when nothing was settled", () => {
		expect(settlingLines()).toEqual([]);
	});
});

let repo: string;
let savedState: string | undefined;

beforeEach(async () => {
	savedState = process.env.XDG_STATE_HOME;
	forgetTreeBroker();
	repo = await freshRepo("work-settling");
	process.env.XDG_STATE_HOME = join(repo, ".git", "state");
});

afterEach(() => {
	forgetTreeBroker();
	if (savedState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedState;
	disposeRepo(repo);
});

/** The work tool, holding the repo as a quest's tree. */
function workTool() {
	const stub = activateWith(workIntegration);
	stub.pi.events.on(WORK_TREE_CLAIMS, (data) => {
		(data as TreeClaims).paths.push(repo);
	});
	const work = toolNamed(stub, "work");
	return (args: Record<string, unknown>) =>
		work.execute("call", args, undefined, undefined, HEADLESS) as Promise<{
			content: { text: string }[];
			details?: { ok?: boolean };
		}>;
}

/** Commit one file's new content on the branch checked out. */
async function commit(path: string, text: string, subject: string) {
	writeFileSync(join(repo, path), text);
	await git(repo, "add", path);
	await git(repo, "commit", "-qm", subject);
}

describe("a rebase through a log both sides appended to", () => {
	it("finishes, and its answer names what it settled", async () => {
		const base = "# History\n\n## 1. First\n\nOne.\n";
		await commit("HISTORY.md", base, "docs: start the history");
		await git(repo, "checkout", "-qb", "topic");
		await commit(
			"HISTORY.md",
			`${base}\n## 2. Mine\n\nAs §2 says.\n`,
			"docs: add mine",
		);
		await git(repo, "checkout", "-q", "main");
		await commit(
			"HISTORY.md",
			`${base}\n## 2. Landed\n\nTheirs.\n`,
			"docs: add landed",
		);
		await git(repo, "checkout", "-q", "topic");

		const answer = await workTool()({
			action: "rebase",
			tree: repo,
			onto: "main",
		});
		const said = answer.content[0]?.text ?? "";

		expect(answer.details?.ok).toBe(true);
		expect(said).toContain("topic replayed onto main, 1 commit.");
		expect(said).toContain("HISTORY.md: both sides only added");
		expect(said).toContain("HISTORY §2 is now HISTORY §3");
		expect(await git(repo, "show", "HEAD:HISTORY.md")).toContain(
			"## 3. Mine\n\nAs §3 says.",
		);
		// A real replay runs dozens of git commands, past vitest's 5 s on a
		// machine busy with a build.
	}, 20_000);

	it("names a later commit's file rewritten for a number moved earlier", async () => {
		// The case found live on 22 October: the second commit's change sits
		// beside the citation the first commit's settling rewrote.
		const base = "# History\n\n## 1. First\n\nOne.\n";
		await commit("HISTORY.md", base, "docs: start the history");
		await commit("AGENTS.md", "# Agents\n", "docs: start the agents");
		await git(repo, "checkout", "-qb", "topic");
		// The entry and its first citation in one commit, as found live.
		writeFileSync(join(repo, "AGENTS.md"), "# Agents\n\nSee HISTORY §2.\n");
		await git(repo, "add", "AGENTS.md");
		await commit("HISTORY.md", `${base}\n## 2. Mine\n`, "docs: add mine");
		await commit(
			"AGENTS.md",
			"# Agents\n\nSee HISTORY §2.\n\nAlso HISTORY §2.\n",
			"docs: cite again",
		);
		await git(repo, "checkout", "-q", "main");
		await commit("HISTORY.md", `${base}\n## 2. Landed\n`, "docs: add landed");
		await git(repo, "checkout", "-q", "topic");

		const answer = await workTool()({
			action: "rebase",
			tree: repo,
			onto: "main",
		});
		const said = answer.content[0]?.text ?? "";

		expect(answer.details?.ok).toBe(true);
		expect(said).toContain("replayed onto main, 2 commits.");
		expect(said).not.toContain("still cite");
		expect(said).toContain(
			"AGENTS.md: citations of a number moved earlier in this replay",
		);
		expect(await git(repo, "show", "HEAD:AGENTS.md")).toBe(
			"# Agents\n\nSee HISTORY §3.\n\nAlso HISTORY §3.",
		);
	}, 20_000);
});
