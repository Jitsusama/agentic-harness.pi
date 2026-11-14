/**
 * What the nix-offload exemption lets out of the fence: derivations
 * already in the store, alone or after one `cd` into a tree the work
 * tool holds for the session, and from such a tree its commit, as
 * `--changed` or a `--run` of store programs, to lent builders alone;
 * never a flake, a tree's named checks, a checkout's commit or a flag
 * that works on this machine, as ISXEG8's reviews of 11 November set
 * out.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitFolders, guardsGitFolder } from "../../../lib/internal/fence.ts";
import {
	LENT_ONLY,
	NO_GIT_DIR,
	type OffloadPlace,
	offloadedOutside,
	offloadKeptIn,
	takesLentOnly,
} from "../../../lib/internal/offload-exemption.ts";
import { folderGit, heldTree } from "../../../lib/internal/sandbox-trees.ts";

const OFFLOAD = {
	program: "/nix/store/0000-nix-offload/bin/nix-offload",
	env: "/nix/store/0000-coreutils/bin/env",
	lentOnly: true,
};
const SCRIPT = "/nix/store/0000-harness-check";
const DRV = `/nix/store/${"a".repeat(32)}-check.drv`;
const OTHER_DRV = `/nix/store/${"b".repeat(32)}-check.drv`;
const RUN = `nix-offload there --run --copy ${SCRIPT} -- ${SCRIPT} main`;
const DRV_CALL = `nix-offload there ${DRV}`;

/** A folder the session holds, as the sandbox vouches for one. */
const HELD: Partial<OffloadPlace> = {
	cwd: "/tree",
	folderGit: (folder) =>
		folder === "/tree" ? { folder, gitDir: "/repo/.git" } : undefined,
};

/** A tree the session holds, which a call may send the commit of. */
const HELD_TREE: Partial<OffloadPlace> = {
	...HELD,
	heldTree: (folder) =>
		folder === "/tree" ? { folder, gitDir: "/repo/.git" } : undefined,
};

/** The shell text for `command`, or nothing when it stays fenced. */
function letOut(
	command: string,
	place: Partial<OffloadPlace> = {},
): string | undefined {
	return offloadedOutside(command, OFFLOAD, {
		home: "/home/someone",
		env: {},
		...place,
	});
}

describe("the flags the exemption lets out", () => {
	it("refuses every flag that builds, waits or runs on this machine", () => {
		for (const command of [
			"nix-offload there --here /tree checks.x86_64-linux.formatting",
			"nix-offload there --here-when-idle /tree checks.x86_64-linux.a",
			"nix-offload there --outlive /tree checks.x86_64-linux.a",
			"nix-offload there --here=1 /tree checks.x86_64-linux.a",
			"nix-offload there --changed --here",
			"nix-offload there --out /home/someone/.config/systemd/user /tree a",
			"nix-offload there --out=/home/someone/.config /tree a",
		]) {
			expect(letOut(command), command).toBeUndefined();
		}
	});

	it("lets out derivations already in the store, with a build's own flags", () => {
		for (const command of [
			`nix-offload there ${DRV}`,
			`nix-offload there ${DRV}^*`,
			`nix-offload there -L --keep-going ${DRV}^out ${OTHER_DRV}`,
			`nix-offload there --print-out-paths --bulk ${DRV}`,
		]) {
			expect(letOut(command), command).toBeDefined();
		}
	});

	it("keeps fenced every flake, tree and changed-checks run, held tree or not", () => {
		for (const command of [
			"nix-offload there --keep-going /tree checks.x86_64-linux.formatting",
			"nix-offload there path:/home/someone/.config/gh checks.x86_64-linux.a",
			"nix-offload there github:o/r/abc checks.x86_64-linux.a",
			"nix-offload there /tree#checks.x86_64-linux.a",
			"nix-offload there -L --changed",
			"nix-offload there --takes",
			"nix-offload there",
			`nix-offload there ${DRV} checks.x86_64-linux.a`,
			`nix-offload there --apply f ${DRV}`,
			`nix-offload there --unknown ${DRV}`,
			"nix-offload there /nix/store/short-check.drv",
			`nix-offload there ${DRV}/../../home/someone/x.drv`,
			`nix-offload there /home/someone/${"a".repeat(32)}-x.drv`,
		]) {
			expect(letOut(command, HELD), command).toBeUndefined();
		}
	});

	it("tells git outside any tree to read no .git at all", () => {
		const text = letOut(`nix-offload there ${DRV}`);
		for (const set of [
			`GIT_DIR=${NO_GIT_DIR}`,
			"GIT_CEILING_DIRECTORIES=/",
			"GIT_CONFIG_KEY_0=core.fsmonitor",
			"GIT_CONFIG_VALUE_0=false",
		]) {
			expect(text, set).toContain(`'${set}'`);
		}
	});

	it("lets out a held tree's commit, as --changed or a --run of store programs", () => {
		for (const command of [
			"nix-offload there --changed",
			"nix-offload there --never-ask --first --changed",
			"nix-offload there --lent-only --changed",
			RUN,
			`nix-offload there --run --copy ${SCRIPT} --longest 1800 -- ${SCRIPT} main`,
			`nix-offload there --never-ask --run -- ${SCRIPT}`,
		]) {
			expect(letOut(command, HELD_TREE), command).toBeDefined();
		}
	});

	it("sends every commit it lets out to the lent builders alone", () => {
		for (const command of ["nix-offload there --changed", RUN]) {
			expect(letOut(command, HELD_TREE), command).toContain(`'${LENT_ONLY}'`);
		}
	});

	it("keeps fenced a commit from a checkout or a folder no tree holds", () => {
		for (const command of ["nix-offload there --changed", RUN]) {
			expect(letOut(command, HELD), `${command} in a checkout`).toBeUndefined();
			expect(letOut(command), `${command} anywhere`).toBeUndefined();
		}
	});

	it("keeps fenced a --changed with arguments, or a --run of anything outside the store", () => {
		for (const command of [
			"nix-offload there --changed --only formatting",
			"nix-offload there --first --never-ask --changed",
			`nix-offload there --run --copy ${SCRIPT} -- bash ${SCRIPT} main`,
			`nix-offload there --run --copy=${SCRIPT} -- ${SCRIPT}`,
			`nix-offload there --run --copy ${SCRIPT} -- /home/someone/x.sh`,
			`nix-offload there --run --copy /home/someone/x.sh -- ${SCRIPT}`,
			`nix-offload there --run --longest soon -- ${SCRIPT}`,
			`nix-offload there --run --copy ${SCRIPT} --`,
			`nix-offload there --run ${SCRIPT}`,
		]) {
			expect(letOut(command, HELD_TREE), command).toBeUndefined();
		}
	});

	it("keeps every commit fenced through a nix-offload that can't keep it to lent builders", () => {
		const older = { ...OFFLOAD, lentOnly: false };
		for (const command of ["nix-offload there --changed", RUN]) {
			expect(
				offloadedOutside(command, older, { home: "/h", env: {}, ...HELD_TREE }),
				command,
			).toBeUndefined();
		}
		expect(
			offloadedOutside(DRV_CALL, older, { home: "/h", env: {} }),
			"a derivations' build still goes",
		).toBeDefined();
	});

	it("asks nix-offload once whether it takes --lent-only", () => {
		const folder = mkdtempSync(join(tmpdir(), "offload-takes-"));
		try {
			const program = (name: string, takes: readonly string[]) => {
				const path = join(folder, name);
				const script = [
					"#!/bin/sh",
					`echo asked >> ${join(folder, `${name}.asked`)}`,
					...takes.map((word) => `echo ${word}`),
				];
				writeFileSync(path, `${script.join("\n")}\n`, { mode: 0o755 });
				return path;
			};
			const newer = program("newer", ["tree", "changed", "lent-only", "run"]);
			const older = program("older", ["tree", "changed", "run"]);
			expect(takesLentOnly(newer), "one that lists it").toBe(true);
			expect(takesLentOnly(newer), "asked again").toBe(true);
			expect(takesLentOnly(older), "one that doesn't").toBe(false);
			expect(takesLentOnly(join(folder, "none")), "none there").toBe(false);
			expect(
				readFileSync(join(folder, "newer.asked"), "utf8"),
				"asked once",
			).toBe("asked\n");
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("leaves a derivations' build to go where it goes", () => {
		expect(letOut(DRV_CALL, HELD_TREE)).not.toContain(LENT_ONLY);
	});
});

describe("a call the exemption keeps in", () => {
	it("is refused saying to evaluate inside, or to send a held tree's commit", () => {
		for (const command of [
			"nix-offload there /tree checks.x86_64-linux.formatting",
			"nix-offload there -L --changed",
			"cd /tree && nix-offload there path:/home/someone/.config/gh checks.x86_64-linux.a",
			RUN,
		]) {
			const said = offloadKeptIn(command);
			expect(said, command).toContain("only derivations");
			expect(said, command).toContain("nix-offload there <drv>^*");
			expect(said, command).toContain(
				"cd <tree> && nix-offload there --changed",
			);
		}
	});

	it("runs fenced when it builds here, asks what it takes, or isn't a lone call", () => {
		for (const command of [
			"nix-offload there --here /tree checks.x86_64-linux.formatting",
			"nix-offload there --takes",
			"nix-offload there /tree checks.x86_64-linux.a && echo out",
			"nix build /tree#checks.x86_64-linux.a",
		]) {
			expect(offloadKeptIn(command), command).toBeUndefined();
		}
	});
});

describe("a cd before the call", () => {
	let base: string;
	let home: string;
	let tree: string;
	let records: string;

	beforeAll(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "offload-cd-")));
		home = join(base, "home");
		const repository = join(base, "repo");
		const own = join(repository, "worktrees", "tree");
		tree = join(base, "trees", "tree");
		records = join(base, "records");
		for (const folder of [
			home,
			join(repository, "objects"),
			own,
			tree,
			records,
		])
			mkdirSync(folder, { recursive: true });
		writeFileSync(join(tree, ".git"), `gitdir: ${own}\n`);
		writeFileSync(join(own, "gitdir"), `${join(tree, ".git")}\n`);
		writeFileSync(join(own, "commondir"), "../..\n");
		writeFileSync(
			join(records, "tree.json"),
			JSON.stringify({
				identity: { key: "tree", shareable: false },
				path: tree,
				providerId: "git-worktree",
				sessions: ["s1"],
			}),
		);
		symlinkSync(tree, join(base, "link"));
	});

	afterAll(() => rmSync(base, { recursive: true, force: true }));

	const vouch = (session: string) => (folder: string) =>
		heldTree(folder, home, session, records);

	it("runs the call in a tree the session holds", () => {
		const text = letOut(`cd ${tree} && ${DRV_CALL}`, {
			heldTree: vouch("s1"),
		});
		expect(text, "a held tree is refused").toBeDefined();
		expect(
			text?.startsWith(`cd '${tree}' && exec -a env`),
			"the call runs from the tree",
		).toBe(true);
	});

	it("holds git to the tree's own git folder, read once", () => {
		const text = letOut(`cd ${tree} && ${DRV_CALL}`, {
			heldTree: vouch("s1"),
		});
		const own = join(base, "repo", "worktrees", "tree");
		for (const set of [
			`GIT_DIR=${own}`,
			`GIT_WORK_TREE=${tree}`,
			"GIT_CONFIG_COUNT=1",
			"GIT_CONFIG_KEY_0=core.fsmonitor",
			"GIT_CONFIG_VALUE_0=false",
		]) {
			expect(text, set).toContain(`'${set}'`);
		}
		expect(text, "no other git folder").not.toContain(NO_GIT_DIR);
	});

	it("sends a held tree's commit from the tree, to the lent builders alone", () => {
		const text = letOut(`cd ${tree} && nix-offload there --changed`, {
			heldTree: vouch("s1"),
		});
		expect(
			text?.startsWith(`cd '${tree}' && exec -a env`),
			"the call runs from the tree",
		).toBe(true);
		expect(text, "lent builders alone").toContain(`'${LENT_ONLY}'`);
		expect(
			letOut(`cd ${tree} && nix-offload there --changed`, {
				heldTree: vouch("s2"),
			}),
			"another session's tree",
		).toBeUndefined();
	});

	it("refuses a tree another session holds, or none", () => {
		expect(
			letOut(`cd ${tree} && ${DRV_CALL}`, {
				heldTree: vouch("s2"),
			}),
			"another session's tree",
		).toBeUndefined();
		expect(
			letOut(`cd ${home} && ${DRV_CALL}`, {
				heldTree: vouch("s1"),
			}),
			"a folder no record names",
		).toBeUndefined();
		expect(
			letOut(`cd ${tree} && ${DRV_CALL}`),
			"nothing to vouch for it",
		).toBeUndefined();
	});

	it("holds a bare call in a held tree to the tree's own git folder", () => {
		const text = letOut(DRV_CALL, {
			cwd: tree,
			folderGit: (folder) => folderGit(folder, home, "s1", records),
		});
		const own = join(base, "repo", "worktrees", "tree");
		expect(text, "the tree's git").toContain(`'GIT_DIR=${own}'`);
		expect(text, "the tree's files").toContain(`'GIT_WORK_TREE=${tree}'`);
	});

	it("refuses a held tree named through a link", () => {
		expect(
			letOut(`cd ${join(base, "link")} && ${DRV_CALL}`, {
				heldTree: vouch("s1"),
			}),
		).toBeUndefined();
	});

	it("refuses a held tree whose git links don't agree", () => {
		const own = join(base, "repo", "worktrees", "tree");
		writeFileSync(join(own, "commondir"), "../../../elsewhere\n");
		try {
			expect(heldTree(tree, home, "s1", records)).toBeUndefined();
		} finally {
			writeFileSync(join(own, "commondir"), "../..\n");
		}
	});

	it("refuses anything chained, substituted or flagged around it", () => {
		const held = { heldTree: vouch("s1") };
		for (const command of [
			`cd ${tree} && ${DRV_CALL} && echo out`,
			`cd ${tree} && cd ${tree} && ${DRV_CALL}`,
			`cd ${tree}; ${DRV_CALL}`,
			`cd $(echo ${tree}) && ${DRV_CALL}`,
			`cd "${tree}" && ${DRV_CALL}`,
			`cd ${tree}/* && ${DRV_CALL}`,
			`cd trees/tree && ${DRV_CALL}`,
			`cd ${tree} && nix-offload there --here ${DRV}`,
			`cd ${tree} && echo out`,
			`cd ${tree} &&\n${DRV_CALL}`,
		]) {
			expect(letOut(command, held), command).toBeUndefined();
		}
	});
});

describe("a bare call in the command's folder", () => {
	let home: string;

	beforeAll(() => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "offload-bare-")));
		for (const where of ["src/r/.git", "src/r/sub", "elsewhere/r/.git"]) {
			mkdirSync(join(home, where), { recursive: true });
		}
		mkdirSync(join(home, "src/linked"), { recursive: true });
		symlinkSync(join(home, "elsewhere/r/.git"), join(home, "src/linked/.git"));
	});

	afterAll(() => rmSync(home, { recursive: true, force: true }));

	const bare = (cwd: string) =>
		letOut(DRV_CALL, {
			home,
			cwd,
			folderGit: (folder) =>
				folderGit(folder, home, "s1", join(home, "elsewhere", "records")),
		});

	it("holds a call in a guarded checkout to that checkout's git", () => {
		const checkout = join(home, "src/r");
		const text = bare(checkout);
		expect(text, "its git folder").toContain(
			`'GIT_DIR=${join(checkout, ".git")}'`,
		);
		expect(text, "its files").toContain(`'GIT_WORK_TREE=${checkout}'`);
		expect(text, "no other git folder").not.toContain(NO_GIT_DIR);
	});

	it("keeps a guarded checkout's commit fenced", () => {
		const records = join(home, "elsewhere", "records");
		expect(
			letOut("nix-offload there --changed", {
				home,
				cwd: join(home, "src/r"),
				folderGit: (folder) => folderGit(folder, home, "s1", records),
				heldTree: (folder) => heldTree(folder, home, "s1", records),
			}),
		).toBeUndefined();
	});

	it("gives git no folder at all anywhere else", () => {
		for (const cwd of [
			join(home, "elsewhere/r"),
			join(home, "src/r/sub"),
			join(home, "src/linked"),
			home,
		]) {
			expect(bare(cwd), cwd).toContain(`'GIT_DIR=${NO_GIT_DIR}'`);
		}
	});
});

describe("the fence's guarded git folders", () => {
	let home: string;

	beforeAll(() => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "guarded-git-")));
	});

	afterAll(() => rmSync(home, { recursive: true, force: true }));

	it("are the ones the walk lists in src and world, told apart one at a time", () => {
		const places = [
			"top",
			".hidden-top",
			"src/a",
			"src/github.com/org/repo",
			"src/w/x/y/z",
			"src/v/w/x/y/z",
			"src/.hidden/r",
			"src/a/inner",
			"world/r",
			"world/r2/deeper",
			"elsewhere/r",
		];
		for (const where of places) {
			mkdirSync(join(home, where, ".git"), { recursive: true });
		}
		const bareRepository = join(home, "src/bare.git");
		mkdirSync(join(bareRepository, "objects"), { recursive: true });
		writeFileSync(join(bareRepository, "HEAD"), "ref: refs/heads/main\n");

		const listed = new Set(gitFolders(home));
		const candidates = [
			...places.map((where) => join(home, where, ".git")),
			bareRepository,
		];
		// A repository in another entry of the home folder is guarded by
		// the fence but counts for nothing: a command can make one there.
		const kept = (git: string) =>
			["src", "world"].some((top) => git.startsWith(join(home, top, "/")));
		for (const git of candidates) {
			expect(guardsGitFolder(git, home), git).toBe(
				listed.has(git) && kept(git),
			);
		}
		expect(
			[...listed],
			"the walk still finds one in the home folder",
		).toContain(join(home, "top/.git"));
		expect(listed.size, "the walk found some and missed some").toBeLessThan(
			candidates.length,
		);
		expect([...listed]).toContain(join(home, "src/a/.git"));
	});
});
