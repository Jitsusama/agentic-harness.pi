import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placeFetchedGit } from "../../../../lib/internal/priority/fetched.ts";

// A git of its own: no person's config, so nothing signs or hooks.
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
};

let root: string;
let queue: string;
let world: string;
let main: string;

const git = (dir: string, ...args: string[]) =>
	execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		env: GIT_ENV,
		input: "",
	}).trim();

/** Runs `git <args>` in a shell answered by the queue. */
const answered = (...args: string[]) =>
	spawnSync(
		"sh",
		["-c", 'PATH="$Q/fetched:$PATH" exec git "$@"', "sh", ...args],
		{
			encoding: "utf8",
			env: { ...GIT_ENV, Q: queue },
			timeout: 30_000,
		},
	);

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fetched-git-"));
	queue = join(root, "jobs");
	world = join(root, "world", "git");
	git(root, "init", "-q", "--bare", world);
	const tree = git(world, "mktree");
	main = git(world, "commit-tree", tree, "-m", "main");
	git(world, "update-ref", "refs/remotes/origin/main", main);
	git(
		world,
		"config",
		"remote.origin.url",
		"https://u@delta.example/shop/world.git",
	);
	expect(placeFetchedGit(queue, world)).toBe(true);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the git an answered shell runs", () => {
	it("is placed runnable in the queue's folder", () => {
		const mode = statSync(join(queue, "fetched", "git")).mode;
		expect(mode & 0o111).not.toBe(0);
	});

	it("answers a fetch of origin's main in World from the ref the other fetch left", () => {
		const ran = answered("-C", world, "fetch", "-q", "origin", "main");
		expect(ran.status).toBe(0);
		expect(ran.stderr).toContain(
			`Answered by the machine queue: a fetch of origin main ended moments ago, and origin/main is ${main.slice(0, 12)}.`,
		);
		expect(readFileSync(join(world, "FETCH_HEAD"), "utf8")).toBe(
			`${main}\t\tbranch 'main' of https://delta.example/shop/world\n`,
		);
		expect(git(world, "rev-parse", "FETCH_HEAD")).toBe(main);
	});

	it("runs the real git for everything else, keeping its output and exit", () => {
		const reads = answered("-C", world, "cat-file", "-t", main);
		expect(reads.status).toBe(0);
		expect(reads.stdout.trim()).toBe("commit");
		const fails = answered("-C", world, "rev-parse", "--verify", "-q", "nope");
		expect(fails.status).toBe(1);
	});

	it("runs the real fetch in any repository but World's", () => {
		// Its origin is nowhere, so the real fetch fails at once, offline.
		const other = join(root, "other.git");
		git(root, "init", "-q", "--bare", other);
		git(other, "config", "remote.origin.url", join(root, "nowhere"));
		const ran = answered("-C", other, "fetch", "-q", "origin", "main");
		expect(ran.status).not.toBe(0);
		expect(ran.stderr).not.toContain("Answered by the machine queue");
		// The real fetch empties FETCH_HEAD as it starts, and failed.
		const head = join(other, "FETCH_HEAD");
		expect(existsSync(head) ? readFileSync(head, "utf8") : "").toBe("");
	});
});
