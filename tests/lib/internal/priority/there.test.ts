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
	checkBuildOf,
	githubRepoOf,
	parseRemoteChecks,
	type Repository,
	repositoryAt,
	sentThere,
} from "../../../../lib/internal/priority/there.ts";

const HEAD = "7e39b08d2e8c94b5a86e8d590977d9291cf5f662";
const READY: Repository = {
	atTop: true,
	clean: true,
	pushed: true,
	head: HEAD,
	origin: "git@github.com:Owner/public.git",
};
const REPOS = ["Owner/public"];
const VM = ".#checks.x86_64-linux.vm-desktop-works";

describe("sending VM checks to the builder by commit", () => {
	it("sends a lone VM check build of a named public repository", () => {
		expect(sentThere(`nix build --no-link -L ${VM}`, READY, REPOS)).toBe(
			`nix-offload there -L github:Owner/public/${HEAD} checks.x86_64-linux.vm-desktop-works`,
		);
	});

	it("keeps the flags it passes on and the command's redirections", () => {
		const command = `direnv exec . nix build --no-link --keep-going '${VM}' .#checks.x86_64-linux.formatting >$TMPDIR/x.log 2>&1`;
		expect(sentThere(command, READY, REPOS)).toBe(
			`nix-offload there --keep-going github:Owner/public/${HEAD} checks.x86_64-linux.vm-desktop-works checks.x86_64-linux.formatting >$TMPDIR/x.log 2>&1`,
		);
	});

	it("leaves a build that isn't a VM check here, where it takes seconds", () => {
		const command = "nix build --no-link .#checks.x86_64-linux.formatting";
		expect(sentThere(command, READY, REPOS)).toBeUndefined();
	});

	it("runs as written what it can't send whole", () => {
		for (const command of [
			// An out-link, which something here may read.
			`nix build ${VM}`,
			// A flag that changes what is built or where.
			`nix build --no-link --rebuild ${VM}`,
			`nix build --no-link --builders '' ${VM}`,
			// Another flake, or a check named through a variable.
			`nix build --no-link path:/elsewhere#checks.x86_64-linux.vm-a`,
			`nix build --no-link .#checks.x86_64-linux.$c`,
			// More than one step.
			`cd sub && nix build --no-link ${VM}`,
			`nix build --no-link ${VM}; echo done`,
			`nix build --no-link ${VM} | tee x.log`,
		]) {
			expect(checkBuildOf(command), command).toBeUndefined();
		}
	});

	it("sends nothing from a tree the builder couldn't build as it stands", () => {
		const command = `nix build --no-link ${VM}`;
		expect(
			sentThere(command, { ...READY, clean: false }, REPOS),
		).toBeUndefined();
		expect(
			sentThere(command, { ...READY, pushed: false }, REPOS),
		).toBeUndefined();
		expect(
			sentThere(command, { ...READY, atTop: false }, REPOS),
		).toBeUndefined();
	});

	it("sends only repositories named, which none are by default", () => {
		const command = `nix build --no-link ${VM}`;
		const other = { ...READY, origin: "git@github.com:Owner/private.git" };
		expect(sentThere(command, other, REPOS)).toBeUndefined();
		expect(sentThere(command, READY, [])).toBeUndefined();
		const notGithub = { ...READY, origin: "git@example.com:Owner/public.git" };
		expect(sentThere(command, notGithub, REPOS)).toBeUndefined();
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

	it("gives what it sends no turn in the machine queue here", () => {
		const sent = sentThere(`nix build --no-link ${VM}`, READY, REPOS) ?? "";
		expect(
			kindOf(`printf '%s\\n' 'remote-check: sent' >&2; ${sent}`),
		).toBeUndefined();
	});
});

describe("the repository a command runs in", () => {
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
