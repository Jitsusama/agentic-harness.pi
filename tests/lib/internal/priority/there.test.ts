import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	kindOf,
	LENDING_WAIT_MS,
} from "../../../../lib/internal/priority/queue.ts";
import {
	builderReady,
	checkBuildsOf,
	flakeThere,
	githubRepoOf,
	parseRemoteChecks,
	type Repository,
	repositoryAt,
	sentThere,
} from "../../../../lib/internal/priority/there.ts";
import { stepsOf } from "../../../../lib/internal/shell/steps.ts";
import { count } from "../../../../lib/ui/index.ts";

const HOME = "/home/someone";
const TREE = `${HOME}/trees/core`;
const HEAD = "7e39b08d2e8c94b5a86e8d590977d9291cf5f662";
const FLAKE = `github:Owner/public/${HEAD}`;
const VM = "checks.x86_64-linux.vm-desktop-works";

/** `command` as sent, every build it finds going to FLAKE. */
function sent(command: string, cwd = TREE): string | undefined {
	const builds = checkBuildsOf(stepsOf(command, cwd, HOME) ?? [], HOME);
	if (builds.length === 0) return undefined;
	return sentThere(
		command,
		builds.map((build) => ({ build, flake: FLAKE })),
	);
}

const SAID = (checks: number) =>
	`printf '%s\\n' 'remote-check: ${count(checks, "check", "checks")} sent to the lent builder by commit, nothing uploaded' >&2; `;

describe("finding the VM check builds a command could send", () => {
	it("sends the forms sessions write, each step in its own place", () => {
		// The commonest form on 29 October, 161 times in a day's logs.
		expect(
			sent(
				`K=${TREE}; cd $K && nix build -L --no-link "git+file://$PWD#${VM}" > $TMPDIR/x.log 2>&1; echo "exit $?"`,
				"/elsewhere",
			),
		).toBe(
			`${SAID(1)}K=${TREE}; cd $K && nix-offload there -L ${FLAKE} ${VM} > $TMPDIR/x.log 2>&1; echo "exit $?"`,
		);
		expect(
			sent(
				`cd ${TREE} && direnv exec . nix build --no-link --keep-going .#${VM} .#checks.x86_64-linux.formatting`,
				"/elsewhere",
			),
		).toBe(
			`${SAID(2)}cd ${TREE} && nix-offload there --keep-going ${FLAKE} ${VM} checks.x86_64-linux.formatting`,
		);
		expect(
			sent(`G=${TREE}; timeout 600 nix build --no-link "path:$G#${VM}"`),
		).toBe(`${SAID(1)}G=${TREE}; timeout 600 nix-offload there ${FLAKE} ${VM}`);
	});

	it("names the flake's folder, and whether it builds untracked files too", () => {
		const [git] = checkBuildsOf(
			stepsOf(`nix build --no-link .#${VM}`, TREE, HOME) ?? [],
			HOME,
		);
		expect(git).toMatchObject({ flake: TREE, whole: false });
		const [path] = checkBuildsOf(
			stepsOf(`nix build --no-link path:${TREE}/#${VM}`, "/x", HOME) ?? [],
			HOME,
		);
		expect(path).toMatchObject({ flake: TREE, whole: true });
	});

	it("leaves a build that isn't a VM check here, where it takes seconds", () => {
		expect(
			sent("nix build --no-link .#checks.x86_64-linux.formatting"),
		).toBeUndefined();
	});

	it("runs as written a build it can't send whole", () => {
		for (const command of [
			// An out-link, which something here may read.
			`nix build .#${VM}`,
			// A flag that changes what is built or where.
			`nix build --no-link --rebuild .#${VM}`,
			`nix build --no-link --builders '' .#${VM}`,
			// A check named through what the command alone can't say.
			`for c in a b; do nix build --no-link .#checks.x86_64-linux.vm-$c; done`,
			`cd $(mktemp -d) && nix build --no-link .#${VM}`,
			// Piped, or in a subshell.
			`nix build --no-link .#${VM} | tee x.log`,
			`(nix build --no-link .#${VM})`,
			// Two flakes in one build.
			`nix build --no-link .#${VM} path:/other#${VM}`,
		]) {
			expect(sent(command), command).toBeUndefined();
		}
	});

	it("gives what it sends no turn in the machine queue here", () => {
		const command = sent(`nix build --no-link .#${VM}`) ?? "";
		expect(command).toContain("nix-offload there");
		expect(kindOf(command)).toBeUndefined();
	});
});

describe("whether a repository's build may go", () => {
	const READY: Repository = {
		atTop: true,
		clean: true,
		pushed: true,
		head: HEAD,
		origin: "git@github.com:Owner/public.git",
	};
	const REPOS = ["Owner/public"];

	it("goes from a clean, pushed top folder of a named repository", () => {
		expect(flakeThere(READY, REPOS)).toBe(FLAKE);
		expect(flakeThere(READY, ["owner/PUBLIC"])).toBe(FLAKE);
	});

	it("stays when the builder couldn't build the tree as it stands", () => {
		expect(flakeThere({ ...READY, clean: false }, REPOS)).toBeUndefined();
		expect(flakeThere({ ...READY, pushed: false }, REPOS)).toBeUndefined();
		expect(flakeThere({ ...READY, atTop: false }, REPOS)).toBeUndefined();
	});

	it("goes only for repositories named, which none are by default", () => {
		const other = { ...READY, origin: "git@github.com:Owner/private.git" };
		expect(flakeThere(other, REPOS)).toBeUndefined();
		expect(flakeThere(READY, [])).toBeUndefined();
		const notGithub = { ...READY, origin: "git@example.com:Owner/public.git" };
		expect(flakeThere(notGithub, REPOS)).toBeUndefined();
		expect(parseRemoteChecks(undefined)).toEqual({ ok: true, value: [] });
		expect(parseRemoteChecks({ repos: ["Owner/public"] })).toEqual({
			ok: true,
			value: ["Owner/public"],
		});
		expect(parseRemoteChecks({ repos: "Owner/public" }).ok).toBe(false);
	});

	it("reads a GitHub origin in each form git writes it", () => {
		expect(githubRepoOf("git@github.com:Jitsusama/core.nix.git")).toBe(
			"Jitsusama/core.nix",
		);
		expect(githubRepoOf("https://github.com/Jitsusama/core.nix")).toBe(
			"Jitsusama/core.nix",
		);
		expect(
			githubRepoOf("https://github.com/Jitsusama/agentic-harness.pi.git"),
		).toBe("Jitsusama/agentic-harness.pi");
	});
});

describe("the repository a flake is in", () => {
	let root: string;
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "there-"));
		mkdirSync(join(root, "origin"));
		git(join(root, "origin"), "init", "-q", "--bare");
		git(root, "clone", "-q", join(root, "origin"), "tree");
		const tree = join(root, "tree");
		git(tree, "config", "user.email", "t@example.com");
		git(tree, "config", "user.name", "t");
		git(tree, "config", "commit.gpgsign", "false");
		writeFileSync(join(tree, "flake.nix"), "{}\n");
		git(tree, "add", "flake.nix");
		git(tree, "commit", "-q", "-m", "first");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("is pushed once a remote branch has HEAD, and clean past untracked files", async () => {
		const tree = join(root, "tree");
		expect(await repositoryAt(tree)).toMatchObject({
			atTop: true,
			clean: true,
			pushed: false,
		});
		git(tree, "push", "-q", "origin", "HEAD");
		writeFileSync(join(tree, "notes.txt"), "untracked\n");
		const pushed = await repositoryAt(tree);
		expect(pushed).toMatchObject({ clean: true, pushed: true });
		expect(pushed?.head).toBe(git(tree, "rev-parse", "HEAD"));
		// A path: flake builds the folder whole, untracked files too.
		expect(await repositoryAt(tree, true)).toMatchObject({ clean: false });

		writeFileSync(join(tree, "flake.nix"), "{ changed = 1; }\n");
		expect(await repositoryAt(tree)).toMatchObject({ clean: false });
		mkdirSync(join(tree, "sub"));
		expect(await repositoryAt(join(tree, "sub"))).toMatchObject({
			atTop: false,
		});
	});

	it("is nothing outside a repository", async () => {
		expect(await repositoryAt(root)).toBeUndefined();
	});
});

describe("whether a builder is ready", () => {
	let root: string;
	const LINE =
		"ssh-ng://builder x86_64-linux /key 8 1 big-parallel big-parallel -\n";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "builder-"));
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const kernel = () => ({
		proc: "/proc",
		cgroups: "/sys/fs/cgroup",
		machines: join(root, "machines"),
		lending: join(root, "lending"),
	});

	it("is ready while one stands, and not with none standing or lent", async () => {
		writeFileSync(join(root, "machines"), LINE);
		expect(await builderReady(kernel())).toBe(true);
		writeFileSync(join(root, "machines"), "");
		expect(await builderReady(kernel())).toBe(false);
	});

	it("waits while one is being lent, until it stands", async () => {
		writeFileSync(join(root, "machines"), "");
		writeFileSync(join(root, "lending"), "builder\n");
		const ready = builderReady(kernel(), undefined, Date.now, 5);
		setTimeout(() => writeFileSync(join(root, "machines"), LINE), 20);
		expect(await ready).toBe(true);
	});

	it("stops waiting on a lend past the queue's few minutes", async () => {
		writeFileSync(join(root, "machines"), "");
		writeFileSync(join(root, "lending"), "builder\n");
		const started = (Date.now() - LENDING_WAIT_MS) / 1000;
		utimesSync(join(root, "lending"), started, started);
		expect(await builderReady(kernel(), undefined, Date.now, 5)).toBe(false);
	});
});
