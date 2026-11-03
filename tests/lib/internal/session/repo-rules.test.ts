import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	RULES_INLINE_LIMIT,
	repoRulesNote,
} from "../../../../lib/internal/session/repo-rules.ts";

let root: string;
let sessionCount = 0;

/** A session id no other test has used, as the given set lives for the process. */
function freshSession(): string {
	sessionCount += 1;
	return `session-${process.pid}-${sessionCount}-${Date.now()}`;
}

/** A folder holding a rules file, as a tree of a repo would. */
function treeWith(name: string, file: string, text: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, file), text);
	return dir;
}

const noRepo = () => undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "repo-rules-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("a tree in a repo whose rules pi did not load at start", () => {
	it("is given its rules whole, with where they came from", () => {
		const tree = treeWith("core", "AGENTS.md", "Run the test pyramid.\n");
		const note = repoRulesNote({
			tree,
			cwd: root,
			session: freshSession(),
			loaded: [],
			repoOf: noRepo,
		});
		expect(note).toContain(join(tree, "AGENTS.md"));
		expect(note).toContain("Run the test pyramid.");
		expect(note).toContain("pi loaded no rules from this repo");
	});

	it("is given them once a session, and again in another session", () => {
		const tree = treeWith("core", "AGENTS.md", "Run the test pyramid.\n");
		const session = freshSession();
		const asked = {
			tree,
			cwd: root,
			session,
			loaded: [],
			repoOf: () => "/repos/core.git",
		};
		expect(repoRulesNote(asked)).toBeDefined();
		// A second tree of the same repo is the same repo's rules.
		const sibling = treeWith("core-2", "AGENTS.md", "Run the test pyramid.\n");
		expect(repoRulesNote({ ...asked, tree: sibling })).toBeUndefined();
		expect(repoRulesNote({ ...asked, session: freshSession() })).toBeDefined();
	});

	it("falls back to CLAUDE.md as pi does when there is no AGENTS.md", () => {
		const tree = treeWith("legacy", "CLAUDE.md", "Use tabs.\n");
		const note = repoRulesNote({
			tree,
			cwd: root,
			session: freshSession(),
			loaded: [],
			repoOf: noRepo,
		});
		expect(note).toContain("Use tabs.");
	});

	// A World tree holds its checkout in src/, and the rules sit there.
	it("reads them from the one checkout below a tree that has none of its own", () => {
		const tree = join(root, "world-tree");
		const checkout = treeWith("world-tree/src", "AGENTS.md", "Use dev.\n");
		mkdirSync(join(checkout, ".git"));
		mkdirSync(join(tree, "target"));
		const note = repoRulesNote({
			tree,
			cwd: root,
			session: freshSession(),
			loaded: [],
			repoOf: noRepo,
		});
		expect(note).toContain(join(checkout, "AGENTS.md"));
		expect(note).toContain("Use dev.");
	});

	it("names the file and asks for it read when it is too long to inline", () => {
		const long = `${"A rule.\n".repeat(RULES_INLINE_LIMIT / 8)}The last rule.\n`;
		const tree = treeWith("walgit", "AGENTS.md", long);
		const note = repoRulesNote({
			tree,
			cwd: root,
			session: freshSession(),
			loaded: [],
			repoOf: noRepo,
		});
		expect(note).toContain(join(tree, "AGENTS.md"));
		expect(note).toMatch(/read it/i);
		expect(note).not.toContain("The last rule.");
	});
});

describe("a tree whose rules are already in the session", () => {
	it("says nothing when pi loaded a rules file from the same repo", () => {
		const tree = treeWith("tree", "AGENTS.md", "Newer rules.\n");
		const checkout = join(root, "checkout");
		const note = repoRulesNote({
			tree,
			cwd: checkout,
			session: freshSession(),
			loaded: [
				{ path: join(checkout, "AGENTS.md"), content: "Older rules.\n" },
			],
			repoOf: () => "/repos/harness.git",
		});
		expect(note).toBeUndefined();
	});

	it("says nothing when the same rules were loaded from elsewhere", () => {
		const tree = treeWith("tree", "AGENTS.md", "Shared rules.\n");
		const note = repoRulesNote({
			tree,
			cwd: root,
			session: freshSession(),
			loaded: [{ path: "/elsewhere/AGENTS.md", content: "Shared rules.\n" }],
			repoOf: noRepo,
		});
		expect(note).toBeUndefined();
	});

	it("says nothing for a tree with no rules file", () => {
		const tree = join(root, "bare");
		mkdirSync(tree);
		expect(
			repoRulesNote({
				tree,
				cwd: root,
				session: freshSession(),
				loaded: [],
				repoOf: noRepo,
			}),
		).toBeUndefined();
	});
});

describe("judged by pi's own loader and git", () => {
	function repo(name: string, rules: string): string {
		const dir = treeWith(name, "AGENTS.md", rules);
		execFileSync("git", ["init", "-q", dir]);
		return dir;
	}

	it("says nothing for the repo the session started in", () => {
		const started = repo("started", "These rules.\n");
		const lib = join(started, "lib");
		mkdirSync(lib);
		expect(
			repoRulesNote({ tree: started, cwd: lib, session: freshSession() }),
		).toBeUndefined();
	});

	it("gives another repo's rules to a session started outside it", () => {
		const other = repo("other", "Other rules.\n");
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere);
		expect(
			repoRulesNote({ tree: other, cwd: elsewhere, session: freshSession() }),
		).toContain("Other rules.");
	});
});
