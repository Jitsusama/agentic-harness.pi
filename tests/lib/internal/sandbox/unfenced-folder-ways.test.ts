/**
 * The ways round a closed path strict won't let a command take: the
 * session's own runtime folder, a link on the way to a closed path, a
 * repository inside a granted folder, and the lenders' folders.
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	ASKED,
	hiddenFolder,
	unfencedFolder,
} from "../../../../lib/internal/sandbox/unfenced-folder.ts";

let base: string;
let count = 0;

beforeAll(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "unfenced-ways-")));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A home of its own for each test, and where the broker would cut trees. */
function laid() {
	count += 1;
	const home = join(base, `home-${count}`);
	mkdirSync(home, { recursive: true });
	return { home, place: { treesRoot: join(home, "trees"), mac: false } };
}

it("closes the session's own runtime folder, and pi's, whichever its commands are given", () => {
	const { home, place } = laid();
	const session = join(home, "run-session");
	const pis = join(home, "run-pi");
	mkdirSync(join(session, "inner"), { recursive: true });
	mkdirSync(join(pis, "inner"), { recursive: true });
	vi.stubEnv("XDG_RUNTIME_DIR", pis);
	try {
		const judged = { ...place, runtimeDir: session };
		expect(
			unfencedFolder(join(session, "inner"), home, ASKED, judged),
			"the session's",
		).toContain(`which lies in ${session}, the runtime folder`);
		expect(
			hiddenFolder(join(session, "inner"), home, ASKED, judged),
			"read in the session's",
		).toContain(`which lies in ${session}, the runtime folder`);
		expect(
			unfencedFolder(join(pis, "inner"), home, ASKED, judged),
			"pi's",
		).toContain(`which lies in ${pis}, the runtime folder`);
	} finally {
		vi.unstubAllEnvs();
	}
});

it("names the variable when the runtime folder it names holds the working folder", () => {
	const { home, place } = laid();
	const work = join(home, "work");
	mkdirSync(work, { recursive: true });
	vi.stubEnv("XDG_RUNTIME_DIR", "");
	try {
		expect(
			unfencedFolder(work, home, ASKED, { ...place, runtimeDir: home }),
		).toContain("XDG_RUNTIME_DIR names");
	} finally {
		vi.unstubAllEnvs();
	}
});

it("refuses a folder holding a link on the way to a closed path, not only its ends", () => {
	const { home, place } = laid();
	const work = join(home, "work");
	const dotfiles = join(home, "dotfiles/config");
	mkdirSync(work, { recursive: true });
	mkdirSync(join(home, "beside"), { recursive: true });
	mkdirSync(dotfiles, { recursive: true });
	// ~/.config -> work/cfg -> dotfiles/config: one command replacing
	// work/cfg would take over every setting git reads from ~/.config.
	symlinkSync(dotfiles, join(work, "cfg"));
	symlinkSync(join(work, "cfg"), join(home, ".config"));
	expect(unfencedFolder(work, home, ASKED, place)).toContain(
		`which holds ${join(work, "cfg")}, a link on the way to ${join(home, ".config")}, a path`,
	);
	expect(
		unfencedFolder(join(home, "beside"), home, ASKED, place),
		"a folder holding none of it",
	).toBeUndefined();
	expect(
		hiddenFolder(work, home, ASKED, place),
		"reading beside a link hands over nothing",
	).toBeUndefined();
});

/**
 * ~/.config led through 45 links, l44 first, the one numbered `held`
 * lying in the working folder: ~/.config is the way's first link, so
 * l5 is its 41st, the last the kernel follows, and l4 its 42nd.
 */
function chained(held: number) {
	const { home, place } = laid();
	const work = join(home, "work");
	const chain = join(home, "chain");
	mkdirSync(work, { recursive: true });
	mkdirSync(chain, { recursive: true });
	mkdirSync(join(home, "target"), { recursive: true });
	let next = join(home, "target");
	for (let hop = 0; hop < 45; hop += 1) {
		const link = join(hop === held ? work : chain, `l${hop}`);
		symlinkSync(next, link);
		next = link;
	}
	symlinkSync(next, join(home, ".config"));
	return { home, place, work };
}

it("refuses a folder holding a link up to the kernel's 41st on a closed path's way", () => {
	const { home, place, work } = chained(5);
	expect(unfencedFolder(work, home, ASKED, place)).toContain(
		`which holds ${join(work, "l5")}, a link on the way to ${join(home, ".config")}, a path`,
	);
});

it("grants a folder holding a link past the kernel's 41st, since replacing it leaves a way the kernel refuses", () => {
	const { home, place, work } = chained(4);
	expect(unfencedFolder(work, home, ASKED, place)).toBeUndefined();
});

it("follows a link's target from where the link leads, so a `..` after a link climbs from there", () => {
	const { home, place } = laid();
	const srv = join(base, `srv-${count}`);
	mkdirSync(join(srv, "x/y"), { recursive: true });
	mkdirSync(join(srv, "x/cfg"), { recursive: true });
	mkdirSync(join(home, "w"), { recursive: true });
	symlinkSync(join(srv, "x/y"), join(home, "w/l"));
	// Relative, as stow writes them: the kernel opens srv/x/cfg.
	symlinkSync("w/l/../cfg", join(home, ".config"));
	expect(unfencedFolder(join(srv, "x"), home, ASKED, place)).toContain(
		`which holds ${join(home, ".config")}, a path`,
	);
	expect(unfencedFolder(join(home, "w"), home, ASKED, place)).toContain(
		`which holds ${join(home, "w/l")}, a link on the way to ${join(home, ".config")}, a path`,
	);
});

it("refuses a folder holding a link on the way to the compiled code pi's next start runs", () => {
	const { home, place } = laid();
	const data = join(base, `data-${count}`);
	mkdirSync(join(data, "ssd/cache"), { recursive: true });
	mkdirSync(join(data, "u"), { recursive: true });
	symlinkSync(join(data, "ssd/cache"), join(data, "u/cache"));
	symlinkSync(join(data, "u/cache"), join(home, ".cache"));
	expect(unfencedFolder(join(data, "u"), home, ASKED, place)).toContain(
		`which holds ${join(data, "u/cache")}, a link on the way to ${join(home, ".cache/pi/agentic-harness.pi/host-compile")}`,
	);
});

it("closes the login's runtime folder by its own name where no variable names it", () => {
	const { home, place } = laid();
	const run = join(home, "run");
	const login = join(run, `user/${process.getuid?.() ?? 0}`);
	mkdirSync(join(login, "inner"), { recursive: true });
	vi.stubEnv("XDG_RUNTIME_DIR", "");
	try {
		expect(
			unfencedFolder(join(login, "inner"), home, ASKED, { ...place, run }),
		).toContain(`which lies in ${login}, the runtime folder`);
	} finally {
		vi.unstubAllEnvs();
	}
});

it("takes no relative XDG_RUNTIME_DIR for a runtime folder, as the variable's own rules say", () => {
	const { home, place } = laid();
	mkdirSync(join(home, "work"), { recursive: true });
	vi.stubEnv("XDG_RUNTIME_DIR", "");
	const cwd = vi.spyOn(process, "cwd").mockReturnValue(home);
	try {
		expect(
			unfencedFolder(join(home, "work"), home, ASKED, {
				...place,
				runtimeDir: "work",
			}),
		).toBeUndefined();
	} finally {
		cwd.mockRestore();
		vi.unstubAllEnvs();
	}
});

it("takes no stray .git above a folder in ~/src for a repository", () => {
	const { home, place } = laid();
	const org = join(home, "src/github.com/org");
	mkdirSync(join(org, "repo/.git/hooks"), { recursive: true });
	mkdirSync(join(org, "repo/sub"), { recursive: true });
	mkdirSync(join(org, "plain"), { recursive: true });
	for (const [stray, lay] of [
		[
			"a dangling link",
			() => symlinkSync(join(home, "nowhere"), join(org, ".git")),
		],
		[
			"a .git file naming nothing",
			() => writeFileSync(join(org, ".git"), "gitdir: /nowhere\n"),
		],
	] as const) {
		rmSync(join(org, ".git"), { force: true });
		lay();
		expect(
			unfencedFolder(join(org, "plain"), home, ASKED, place),
			stray,
		).toContain("outside any repository's work");
		expect(
			unfencedFolder(join(org, "repo/sub"), home, ASKED, place),
			`a real repository's work below ${stray}`,
		).toBeUndefined();
	}
});

it("refuses a folder holding another repository's git folder below it", () => {
	const { home, place } = laid();
	const repo = join(home, "src/github.com/org/repo");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(repo, "vendor/dep/.git/hooks"), { recursive: true });
	mkdirSync(join(repo, "lib/deep/er/still/more/.git"), { recursive: true });
	mkdirSync(join(repo, "docs"), { recursive: true });
	expect(unfencedFolder(join(repo, "vendor"), home, ASKED, place)).toContain(
		`which holds ${join(repo, "vendor/dep/.git")}, another repository's git folder`,
	);
	expect(
		unfencedFolder(join(repo, "docs"), home, ASKED, place),
		"a folder holding none",
	).toBeUndefined();
	expect(
		unfencedFolder(join(repo, "lib"), home, ASKED, place),
		"one deeper than the walk goes",
	).toBeUndefined();
});

it("refuses the lenders' folders, where the cloud token lies", () => {
	const { home, place } = laid();
	const run = join(home, "run");
	mkdirSync(join(run, "nix-offload-x/inner"), { recursive: true });
	mkdirSync(join(run, "nix-offload-standing"), { recursive: true });
	const judged = { ...place, run };
	expect(
		unfencedFolder(join(run, "nix-offload-x/inner"), home, ASKED, judged),
	).toContain(`which lies in ${join(run, "nix-offload-x")}, a path`);
	expect(
		hiddenFolder(join(run, "nix-offload-x/inner"), home, ASKED, judged),
	).toContain(`which lies in ${join(run, "nix-offload-x")}, a path`);
	expect(
		unfencedFolder(join(run, "nix-offload-standing"), home, ASKED, judged),
		"a folder named alike that holds no token",
	).toBeUndefined();
});

it("lets a fence that lays the caches, but not bubblewrap's mounts, keep refusing what bubblewrap alone lays", () => {
	const { home, place } = laid();
	mkdirSync(join(home, "src/github.com/org"), { recursive: true });
	const run = join(home, "run");
	mkdirSync(join(run, "nix-offload-x"), { recursive: true });
	const cachesOnly = { ...place, cachesLaid: true, bubblewrap: false };
	expect(
		unfencedFolder(join(run, "nix-offload-x"), home, ASKED, {
			...cachesOnly,
			run,
		}),
		"a lender's folder outside the home",
	).toContain(`which lies in ${join(run, "nix-offload-x")}, a path`);
	expect(
		unfencedFolder(join(home, "src/github.com/org"), home, ASKED, cachesOnly),
	).toContain("outside any repository's work");
	expect(
		unfencedFolder(join(home, "src/github.com/org"), home, ASKED, {
			...cachesOnly,
			bubblewrap: true,
		}),
	).toBeUndefined();
});
