/**
 * `work record` with no paths named refuses to sweep in build output.
 *
 * On 12 October a branch without its sibling's `.gitignore` had a Rust
 * `target/` directory committed and pushed by a record that named no
 * paths. A build's output is never work, and taking it back out means
 * rewriting a pushed branch, so such a sweep is refused before anything
 * is staged, and naming the paths is the way on.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangedPath } from "@jitsusama/agentic-harness.core/work";
import {
	type TreeClaims,
	WORK_TREE_CLAIMS,
} from "@jitsusama/agentic-harness.core/work";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetTreeBroker } from "../../extensions/work-integration/broker.ts";
import workIntegration from "../../extensions/work-integration/index.ts";
import {
	SWEEP_LIMIT,
	sweepObjection,
} from "../../extensions/work-integration/tools/sweep.ts";
import { disposeRepo, freshRepo, git } from "../support/git-fixture.ts";
import {
	activateWith,
	HEADLESS,
	toolNamed,
} from "./support/review-extension.ts";

/** Untracked files at these paths. */
function untracked(...paths: string[]): ChangedPath[] {
	return paths.map((path) => ({ path, staged: false, kind: "untracked" }));
}

describe("what a sweep would take in", () => {
	it("is fine for ordinary new and changed files", () => {
		expect(
			sweepObjection([
				...untracked("src/new.rs", "docs/target-audience.md"),
				{ path: "target/kept.txt", staged: false, kind: "modified" },
			]),
		).toBeUndefined();
	});

	it("names each build-output directory with how many files it holds", () => {
		const said = sweepObjection(
			untracked(
				"modules/disk-guard/target/debug/a",
				"modules/disk-guard/target/debug/b",
				"web/node_modules/x/index.js",
				"src/main.rs",
			),
		);

		expect(said).toContain("modules/disk-guard/target/ (2 files)");
		expect(said).toContain("web/node_modules/ (1 file)");
		expect(said).toContain(".gitignore");
		expect(said).toContain("name the paths");
	});

	it("does not read a file named like a build directory as one", () => {
		expect(sweepObjection(untracked("docs/target"))).toBeUndefined();
	});

	it("refuses a pile of untracked files past the limit, naming where", () => {
		const many = Array.from({ length: SWEEP_LIMIT + 1 }, (_, i) =>
			i === 0 ? "README.extra" : `vendor/lib/f${i}.c`,
		);

		const said = sweepObjection(untracked(...many));

		expect(said).toContain(`${SWEEP_LIMIT + 1} untracked files`);
		expect(said).toContain(`vendor/ (${SWEEP_LIMIT} files)`);
		expect(said).toContain('paths ["."]');
	});

	it("lets exactly the limit through", () => {
		const many = Array.from({ length: SWEEP_LIMIT }, (_, i) => `v/f${i}`);

		expect(sweepObjection(untracked(...many))).toBeUndefined();
	});
});

let repo: string;
let savedState: string | undefined;

beforeEach(async () => {
	savedState = process.env.XDG_STATE_HOME;
	forgetTreeBroker();
	repo = await freshRepo("record-sweep");
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
	// Record reads the session's gate history for the prose gate.
	const ctx = { ...HEADLESS, sessionManager: { getEntries: () => [] } };
	return (args: Record<string, unknown>) =>
		work.execute("call", args, undefined, undefined, ctx) as Promise<{
			content: { text: string }[];
			details?: { ok?: boolean; recorded?: number };
		}>;
}

/** A source change beside a build's output directory. */
function workBesideTarget(): void {
	writeFileSync(join(repo, "lib.rs"), "fn main() {}\n");
	mkdirSync(join(repo, "target", "debug"), { recursive: true });
	writeFileSync(join(repo, "target", "debug", "lib"), "binary\n");
}

describe("recording through the work tool", () => {
	it("stages nothing and commits nothing when the sweep takes build output", async () => {
		workBesideTarget();
		const before = await git(repo, "rev-parse", "HEAD");

		const answer = await workTool()({
			action: "record",
			tree: repo,
			subject: "feat(lib): add the library",
		});

		expect(answer.content[0]?.text).toContain("target/ (1 file)");
		expect(await git(repo, "rev-parse", "HEAD")).toBe(before);
		expect(await git(repo, "diff", "--cached", "--name-only")).toBe("");
	});

	it("records the paths named, and counts only what it committed", async () => {
		workBesideTarget();

		const answer = await workTool()({
			action: "record",
			tree: repo,
			subject: "feat(lib): add the library",
			paths: ["lib.rs"],
		});

		expect(await git(repo, "show", "--name-only", "--format=", "HEAD")).toBe(
			"lib.rs",
		);
		expect(answer.details?.recorded).toBe(1);
		expect(answer.content[0]?.text).toContain("Recorded 1 path in");
	});
});
