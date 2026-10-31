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
	copyThere,
	flakeThere,
	githubRepoOf,
	parseRemoteChecks,
	type Repository,
	repositoryAt,
	sentThere,
	subtestRunsOf,
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
	`printf '%s\\n' 'remote-check: ${count(checks, "check", "checks")} sent to the lent builder from its commit' >&2; `;

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

	it("sends a build pinned to a commit, piped or not", () => {
		// 106 of the 180 commands #886 couldn't read on 29 October.
		const command = `K=${TREE}; cd $K && R=$(git rev-parse 9a6eebb0); nix build -L --no-link "git+file://$PWD?rev=$R#${VM}" 2>&1 | tail -20`;
		const steps = stepsOf(command, "/elsewhere", HOME) ?? [];
		const [build] = checkBuildsOf(steps, HOME);
		expect(build).toMatchObject({
			flake: TREE,
			pin: { ref: "9a6eebb0", folder: TREE },
		});
		expect(sent(command, "/elsewhere")).toBe(
			`${SAID(1)}K=${TREE}; cd $K && R=$(git rev-parse 9a6eebb0); nix-offload there -L ${FLAKE} ${VM} 2>&1 | tail -20`,
		);
		const [written] = checkBuildsOf(
			stepsOf(
				`nix build --no-link "git+file://${TREE}?rev=86a1f2e#${VM}"`,
				"/x",
				HOME,
			) ?? [],
			HOME,
		);
		expect(written?.pin).toEqual({ ref: "86a1f2e", folder: TREE });
		const [elsewhere] = checkBuildsOf(
			stepsOf(
				`S=$(git -C ${TREE} rev-parse HEAD); nix build --no-link "git+file://${TREE}?rev=$S#${VM}"`,
				"/x",
				HOME,
			) ?? [],
			HOME,
		);
		expect(elsewhere?.pin).toEqual({ ref: "HEAD", folder: TREE });
		const [inline] = checkBuildsOf(
			stepsOf(
				`cd ${TREE} && nix build --no-link "git+file://$PWD?rev=$(git rev-parse HEAD)#${VM}"`,
				"/x",
				HOME,
			) ?? [],
			HOME,
		);
		expect(inline?.pin).toEqual({ ref: "HEAD", folder: TREE });
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
			// In the background, or in a subshell.
			`nix build --no-link .#${VM} &`,
			`(nix build --no-link .#${VM})`,
			// Pinned to what only running something else would say.
			`R=$(cat rev); nix build --no-link "git+file://$PWD?rev=$R#${VM}"`,
			`nix build --no-link "git+file://$PWD?rev=$R#${VM}"`,
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

describe("finding the run-subtests runs a command could send", () => {
	const runs = (command: string, cwd = TREE) =>
		subtestRunsOf(stepsOf(command, cwd, HOME) ?? [], HOME);

	it("sends the forms sessions write, each in its own place", () => {
		// Seven of fifteen VM jobs on the workstation in an hour.
		const command = `cd ${TREE} && direnv exec . run-subtests vm-desktop-launcher-answers power_says >$TMPDIR/pw.log 2>&1; echo $?`;
		const found = runs(command, "/elsewhere");
		expect(found.map((run) => run.flake)).toEqual([TREE]);
		const written = sentThere(command, [], found);
		expect(written).toBe(
			`printf '%s\\n' 'remote-check: ${count(1, "subtests run", "subtests runs")} sent to the lent builder from its commit' >&2; cd ${TREE} && direnv exec . run-subtests --there vm-desktop-launcher-answers power_says >$TMPDIR/pw.log 2>&1; echo $?`,
		);
		expect(kindOf(written)).toBeUndefined();
		expect(runs("nix develop -c run-subtests vm-a x")).toHaveLength(1);
		expect(
			runs('nix develop "path:/t" -c run-subtests vm-a x').map(
				(run) => run.flake,
			),
		).toEqual([TREE]);
		expect(
			runs(`run-subtests --flake ${TREE}/ vm-a x`, "/x").map(
				(run) => run.flake,
			),
		).toEqual([TREE]);
	});

	it("runs here what needs a person at it, or isn't a run", () => {
		for (const command of [
			"run-subtests -I vm-a x",
			"run-subtests -K vm-a x",
			"run-subtests --there vm-a x",
			"direnv exec . run-subtests --help 2>&1 | head -8",
			"run-subtests vm-a x &",
			"cat run-subtests.py",
		]) {
			expect(runs(command), command).toEqual([]);
		}
		expect(kindOf("run-subtests vm-a x")).toBe("vm-test");
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

	it("goes as the tree itself, unpushed or changed, where there takes one", () => {
		// Four of fifteen VM jobs in an hour were of a commit not yet pushed.
		const changed = { ...READY, clean: false, pushed: false };
		expect(flakeThere(changed, REPOS, TREE)).toBe(TREE);
		expect(flakeThere(READY, REPOS, TREE)).toBe(FLAKE);
		expect(
			flakeThere({ ...changed, atTop: false }, REPOS, TREE),
		).toBeUndefined();
		const other = { ...changed, origin: "git@github.com:Owner/private.git" };
		expect(flakeThere(other, REPOS, TREE)).toBeUndefined();
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
		expect(await repositoryAt(tree, { whole: true })).toMatchObject({
			clean: false,
		});

		writeFileSync(join(tree, "flake.nix"), "{ changed = 1; }\n");
		expect(await repositoryAt(tree)).toMatchObject({ clean: false });
		mkdirSync(join(tree, "sub"));
		expect(await repositoryAt(join(tree, "sub"))).toMatchObject({
			atTop: false,
		});
	});

	it("is of the commit a build is pinned to, whatever the tree holds", async () => {
		const tree = join(root, "tree");
		const first = git(tree, "rev-parse", "HEAD");
		git(tree, "push", "-q", "origin", "HEAD");
		writeFileSync(join(tree, "flake.nix"), "{ changed = 1; }\n");
		git(tree, "commit", "-qam", "second, unpushed");
		writeFileSync(join(tree, "flake.nix"), "{ changed = 2; }\n");

		const pin = (ref: string) => ({ pin: { ref, folder: tree } });
		expect(await repositoryAt(tree, pin(first.slice(0, 8)))).toMatchObject({
			head: first,
			clean: true,
			pushed: true,
		});
		expect(await repositoryAt(tree, pin("HEAD"))).toMatchObject({
			pushed: false,
		});
	});

	it("is nothing outside a repository", async () => {
		expect(await repositoryAt(root)).toBeUndefined();
	});

	it("is a copy with no origin and no commit, as `git init` leaves one", async () => {
		const copy = join(root, "copy");
		mkdirSync(copy);
		writeFileSync(join(copy, "flake.nix"), "{}\n");
		git(copy, "init", "-q");
		git(copy, "add", "-A");
		expect(await repositoryAt(copy)).toMatchObject({
			atTop: true,
			pushed: false,
			head: "",
			origin: "",
		});
	});
});

describe("whether a copy of a tree may go as a folder", () => {
	const TAKES = {
		tree: true,
		subtests: true,
		wants: true,
		folder: true,
		changed: true,
	};
	const COPY: Repository = {
		atTop: true,
		clean: false,
		pushed: false,
		head: "",
		origin: "",
	};

	it("goes as its folder, a path: build whole, where there takes one", () => {
		// QGB4ON's four VM checks on optimus at load 43, on 30 October.
		expect(copyThere(COPY, TREE, true, TAKES)).toBe(`path:${TREE}`);
		expect(copyThere(COPY, TREE, false, TAKES)).toBe(TREE);
		expect(copyThere(undefined, TREE, true, TAKES)).toBe(`path:${TREE}`);
	});

	it("stays where there takes no folder, or the copy is somebody's tree", () => {
		expect(
			copyThere(COPY, TREE, true, { ...TAKES, folder: false }),
		).toBeUndefined();
		// One with an origin is flakeThere's: a World tree's is Delta.
		const world = { ...COPY, origin: "https://delta.example/world.git" };
		expect(copyThere(world, TREE, true, TAKES)).toBeUndefined();
		// Unknown to git, as a slow monorepo's can be, only a path: build
		// is known to send just its folder.
		expect(copyThere(undefined, TREE, false, TAKES)).toBeUndefined();
		expect(
			copyThere({ ...COPY, atTop: false }, TREE, false, TAKES),
		).toBeUndefined();
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
