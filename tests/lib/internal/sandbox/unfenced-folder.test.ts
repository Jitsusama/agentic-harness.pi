/**
 * The folders strict won't let a command write as its own, since what's
 * written there is read later outside every sandbox.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeCompileFolderOf } from "../../../../lib/internal/fence/compile-cache-place.ts";
import {
	SANDBOX_VARIABLE,
	STRICT,
} from "../../../../lib/internal/sandbox/sandbox.ts";
import {
	ASKED,
	hiddenFolder,
	unfencedFolder,
} from "../../../../lib/internal/sandbox/unfenced-folder.ts";
import { cutTreeDir } from "../../../../lib/internal/work-records.ts";

describe("a working folder the sandbox won't let commands write", () => {
	let home: string;

	beforeAll(() => {
		home = mkdtempSync(join(tmpdir(), "unfenced-home-"));
		mkdirSync(join(home, "checkout/.git"), { recursive: true });
		mkdirSync(join(home, "worktree"));
		writeFileSync(
			join(home, "worktree/.git"),
			`gitdir: ${join(home, "checkout/.git/worktrees/worktree")}\n`,
		);
	});

	afterAll(() => rmSync(home, { recursive: true, force: true }));

	it("is the home folder, or one holding it", () => {
		expect(unfencedFolder(home, home)).toContain("startup files");
		expect(unfencedFolder(join(home, ".."), home)).toContain("startup files");
	});

	it("is one holding or inside the records a machine's node trusts, and not a tree beside them", () => {
		for (const holding of [
			".local",
			".local/state",
			".local/state/pi/agentic-harness.pi",
			".local/state/pi/agentic-harness.pi/hosts",
			".local/state/pi/agentic-harness.pi/hosts/sub",
			".local/state/mycelium",
			".local/state/mycelium/x",
		]) {
			expect(unfencedFolder(join(home, holding), home), holding).toContain(
				"node",
			);
		}
		expect(
			unfencedFolder(
				join(home, ".local/state/pi/agentic-harness.pi/work/trees/t"),
				home,
				ASKED,
				{
					treesRoot: join(
						home,
						".local/state/pi/agentic-harness.pi/work/trees",
					),
				},
			),
		).toBeUndefined();
	});

	it("is one holding or inside the code pi and its host compiled", () => {
		for (const at of [
			".cache",
			".cache/pi/agentic-harness.pi/host-compile",
			".cache/pi/agentic-harness.pi/host-compile/v1/x",
			// A child named `..x` lies inside; only `..` itself leads out.
			".cache/pi/agentic-harness.pi/host-compile/..x",
			".local/state/pi/agentic-harness.pi/host-compile",
			".local/state/pi/agentic-harness.pi/host-compile/work-background-x",
			".local/state/pi/agentic-harness.pi/node-compile-cache",
		]) {
			expect(unfencedFolder(join(home, at), home), at).toContain("compiled");
		}
		for (const at of ["/tmp/jiti", "/tmp/node-compile-cache/v1"]) {
			expect(unfencedFolder(at, home), at).toContain("compiled");
		}
		// Refused whichever it names first: the test's own state lies there too.
		expect(unfencedFolder("/tmp", home), "/tmp").toContain("won't let");
		expect(
			unfencedFolder(
				join(home, ".cache/pi/agentic-harness.pi/quest-workspace/Q"),
				home,
			),
		).toBeUndefined();
	});

	it("is one holding or inside the code compiled into the runtime folder", () => {
		// One of its own, since the runtime folder is hidden only where it
		// is there, whatever the platform or the login's uid.
		const runtime = mkdtempSync(join(tmpdir(), "unfenced-run-"));
		vi.stubEnv("XDG_RUNTIME_DIR", runtime);
		try {
			for (const at of [
				join(runtime, "pi-compile"),
				join(runtime, "pi-compile", "host"),
				join(runtime, "pi-compile", "node", "v1"),
			]) {
				expect(unfencedFolder(at, home), at).toContain("compiled");
			}
			// Its neighbours are refused too, as the runtime folder the fence
			// hides, and not as compiled code.
			const beside = unfencedFolder(join(runtime, "pi-fence"), home);
			expect(beside).toContain("a path the fence hides");
			expect(beside).not.toContain("compiled");
		} finally {
			vi.unstubAllEnvs();
			rmSync(runtime, { recursive: true, force: true });
		}
	});

	it("is one spelled through a quest's TMPDIR link in the runtime folder, though it leads into the scratch", () => {
		// strict gives each command a TMPDIR of its own and never bound a
		// quest's scratch, so a folder named through the link is judged
		// where it is spelled: in the runtime folder the fence hides. This
		// says what holds rather than guarding a change: the folder check
		// reads no TMPDIR, so it refuses the path for lying in the runtime
		// folder alone (F12 on #2125).
		const runtime = mkdtempSync(join(tmpdir(), "unfenced-run-"));
		const scratch = mkdtempSync(join(tmpdir(), "unfenced-scratch-"));
		const link = join(runtime, "pi-quest-QEST-20261124-ABCDEF");
		symlinkSync(scratch, link);
		vi.stubEnv("XDG_RUNTIME_DIR", runtime);
		try {
			const refusal = unfencedFolder(join(link, "work"), home);
			expect(refusal).toContain("a path the fence hides");
			expect(
				unfencedFolder(join(scratch, "work"), home),
				"the scratch spelled as itself is not the runtime folder's",
			).toBeUndefined();
		} finally {
			vi.unstubAllEnvs();
			rmSync(runtime, { recursive: true, force: true });
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("lets pi-fence grant a compile folder reached through a linked root, which the fence lays no tmpfs over and no host compiles into", () => {
		// A runtime folder of its own, whose compile root is a link, as one
		// planted there would be: bubblewrap can't mount over the link, so
		// the fence keeps the runtime folder read-only instead of a tmpfs.
		const runtime = mkdtempSync(join(tmpdir(), "unfenced-run-"));
		const planted = mkdtempSync(join(tmpdir(), "unfenced-planted-"));
		mkdirSync(join(planted, "host"));
		symlinkSync(planted, join(runtime, "pi-compile"));
		vi.stubEnv("XDG_RUNTIME_DIR", runtime);
		try {
			const at = join(runtime, "pi-compile", "host");
			const place = { treesRoot: join(home, "trees"), mac: false };
			expect(unfencedFolder(at, home, ASKED, place), "strict").toContain(
				"compiled",
			);
			expect(
				unfencedFolder(at, home, ASKED, { ...place, cachesClosed: true }),
				"pi-fence, which takes it for a tmpfs of its own",
			).toBeUndefined();
			expect(
				runtimeCompileFolderOf(
					"host",
					{ XDG_RUNTIME_DIR: runtime, HOME: home },
					"linux",
					runtime,
				),
				"what a command writes there is never a host's compiled code",
			).toBeUndefined();
		} finally {
			vi.unstubAllEnvs();
			rmSync(runtime, { recursive: true, force: true });
			rmSync(planted, { recursive: true, force: true });
		}
	});

	it("is one holding or inside a path the fence hides or keeps read-only, and not a tree the work tool cut", () => {
		const trees = join(home, ".local/state/pi/agentic-harness.pi/work/trees");
		const place = { treesRoot: trees, mac: false };
		for (const closed of [
			".config",
			".config/dev",
			".pi/agent",
			".pi/agent/extensions",
			".local/state/pi/agentic-harness.pi/fence-stage",
			".local/state/pi/agentic-harness.pi/fence-stage/s",
			".local/state/aquifer-cell",
			".local/share",
		]) {
			expect(
				unfencedFolder(join(home, closed), home, ASKED, place),
				closed,
			).toContain("a path the fence hides or keeps read-only");
		}
		expect(
			unfencedFolder(join(trees, "t"), home, ASKED, place),
			"a tree",
		).toBeUndefined();
		expect(
			unfencedFolder(trees, home, ASKED, place),
			"the trees' own folder",
		).toContain("hides or keeps read-only");
		expect(
			unfencedFolder(join(home, ".configs"), home, ASKED, place),
			"a neighbour sharing the name's start",
		).toBeUndefined();
		// A tree is spared for where it really lies, so a link in one that
		// leads out is judged where it leads, and refused.
		mkdirSync(join(trees, "t"), { recursive: true });
		mkdirSync(join(home, ".config"), { recursive: true });
		symlinkSync(join(home, ".config"), join(trees, "t/cfg"));
		expect(
			unfencedFolder(join(trees, "t/cfg"), home, ASKED, place),
			"a link out of a tree",
		).toContain("a path the fence hides or keeps read-only");
	});

	it("names a closed path it holds that is there before one that isn't", () => {
		const at = join(home, "held-there");
		mkdirSync(join(at, ".local/share/nvim"), { recursive: true });
		const place = { treesRoot: join(at, "trees"), mac: false };
		// .local itself holds the node's records, which are named first.
		expect(
			unfencedFolder(join(at, ".local/share"), at, ASKED, place),
		).toContain(`which holds ${join(at, ".local/share/nvim")}, a path`);
	});

	it("is one in ~/src and ~/world outside a repository's work, at any depth, and not one in a repository", () => {
		const at = join(home, "repo-homes");
		const place = { treesRoot: join(at, "trees"), mac: false };
		mkdirSync(join(at, "src/github.com/org/repo/.git/hooks"), {
			recursive: true,
		});
		mkdirSync(join(at, "src/github.com/org/repo/sub"), { recursive: true });
		mkdirSync(join(at, "src/a/b/c/d/repo/.git"), { recursive: true });
		mkdirSync(join(at, "world/area"), { recursive: true });
		mkdirSync(join(at, "world/trees/t/src/.git"), { recursive: true });
		mkdirSync(join(at, "world/trees/t/src/area"), { recursive: true });
		for (const above of [
			"src",
			"src/github.com",
			"src/github.com/org",
			"src/a/b/c/d",
			"world",
			"world/area",
			"world/trees/t",
		]) {
			expect(
				unfencedFolder(join(at, above), at, ASKED, place),
				above,
			).toContain("outside any repository's work");
		}
		for (const below of [
			"src/github.com/org/repo/sub",
			"world/trees/t/src/area",
		]) {
			expect(
				unfencedFolder(join(at, below), at, ASKED, place),
				below,
			).toBeUndefined();
		}
		expect(
			unfencedFolder(join(at, "world/trees/t/src"), at, ASKED, place),
		).toContain("holds its repository's git folder");
		expect(
			unfencedFolder(join(at, "SRC/github.com"), at, ASKED, {
				...place,
				mac: true,
			}),
		).toContain(`which lies in ${join(realpathSync(at), "src")} outside`);
	});

	it("is one in any git folder, outside the repository homes too, for every fence", () => {
		const at = join(home, "git-folders");
		mkdirSync(join(at, "notes/.git/hooks"), { recursive: true });
		mkdirSync(join(at, "src/github.com/org/repo/.git/hooks"), {
			recursive: true,
		});
		// A bare repository, found only by its HEAD and objects.
		mkdirSync(join(at, "mirrors/foo.git/objects"), { recursive: true });
		mkdirSync(join(at, "mirrors/foo.git/hooks"));
		writeFileSync(join(at, "mirrors/foo.git/HEAD"), "ref: refs/heads/main\n");
		// A .git leading to a folder named otherwise, found only as spelled,
		// and a link named otherwise leading into a .git, found only past it.
		mkdirSync(join(at, "store/linked/hooks"), { recursive: true });
		mkdirSync(join(at, "linked"));
		symlinkSync(join(at, "store/linked"), join(at, "linked/.git"));
		symlinkSync(join(at, "notes/.git/hooks"), join(at, "to-hooks"));
		const notes = join(realpathSync(at), "notes/.git");
		const place = { treesRoot: join(at, "trees"), mac: false };
		for (const [inside, git] of [
			["notes/.git", join(at, "notes/.git")],
			["notes/.git/hooks", join(at, "notes/.git")],
			[
				"src/github.com/org/repo/.git/hooks",
				join(at, "src/github.com/org/repo/.git"),
			],
			["mirrors/foo.git", realpathSync(join(at, "mirrors/foo.git"))],
			["mirrors/foo.git/hooks", realpathSync(join(at, "mirrors/foo.git"))],
			["linked/.git/hooks", join(at, "linked/.git")],
			["to-hooks", notes],
		] as const) {
			for (const judged of [place, { ...place, cachesClosed: true }]) {
				expect(
					unfencedFolder(join(at, inside), at, ASKED, judged),
					inside,
				).toContain(`which lies in ${git}, a repository's git folder`);
			}
		}
	});

	it("is not a worktree kept inside its bare repository's folder, whose own git lies elsewhere", () => {
		const at = join(home, "bare-with-worktrees");
		mkdirSync(join(at, "proj/objects"), { recursive: true });
		mkdirSync(join(at, "proj/worktrees/main"), { recursive: true });
		writeFileSync(join(at, "proj/HEAD"), "ref: refs/heads/main\n");
		mkdirSync(join(at, "proj/main/lib"), { recursive: true });
		writeFileSync(
			join(at, "proj/main/.git"),
			`gitdir: ${join(at, "proj/worktrees/main")}\n`,
		);
		const place = { treesRoot: join(at, "trees"), mac: false };
		for (const inside of ["proj/main", "proj/main/lib"]) {
			for (const judged of [place, { ...place, cachesClosed: true }]) {
				expect(
					unfencedFolder(join(at, inside), at, ASKED, judged),
					inside,
				).toBeUndefined();
			}
		}
	});

	it("asks a Mac's disk about a repository as its folders are spelled, as a case-sensitive volume needs", () => {
		const at = join(home, "case-sensitive");
		const lib = join(at, "src/github.com/Org/Repo/lib");
		mkdirSync(lib, { recursive: true });
		mkdirSync(join(at, "src/github.com/Org/Repo/.git"), { recursive: true });
		expect(
			unfencedFolder(lib, at, ASKED, {
				treesRoot: join(at, "trees"),
				mac: true,
			}),
		).toBeUndefined();
	});

	it("says why rather than throwing when a closed path's linked folder is now a file", () => {
		const dots = join(realpathSync(home), "file-dots");
		mkdirSync(dots, { recursive: true });
		writeFileSync(join(dots, "gsutil"), "");
		const stowed = join(home, "stowed-home");
		mkdirSync(stowed, { recursive: true });
		symlinkSync(join(dots, "gsutil"), join(stowed, ".gsutil"));
		const place = { treesRoot: join(stowed, "trees"), mac: false };
		expect(unfencedFolder(dots, stowed, ASKED, place)).toContain(
			`which holds ${join(stowed, ".gsutil/credstore2")}, a path`,
		);
	});

	it("is one in or holding what the fence hides outside the home folder", () => {
		const runtime = join(home, "runtime");
		mkdirSync(join(runtime, "inner"), { recursive: true });
		vi.stubEnv("XDG_RUNTIME_DIR", runtime);
		try {
			const place = { treesRoot: join(home, "trees"), mac: false };
			expect(
				unfencedFolder(join(runtime, "inner"), home, ASKED, place),
			).toContain(`which lies in ${runtime}, a path`);
			expect(
				hiddenFolder(join(runtime, "inner"), home, ASKED, place),
			).toContain(`which lies in ${runtime}, a path the fence hides`);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it.runIf(["/tmp/.X11-unix", "/run/dbus"].some(existsSync))(
		"lets pi's file tools read beside X's or the bus's sockets, which hold nothing to read, but not write there",
		() => {
			const sockets = ["/tmp/.X11-unix", "/run/dbus"].find(existsSync) ?? "";
			vi.stubEnv("XDG_RUNTIME_DIR", "");
			try {
				const place = { treesRoot: join(home, "trees"), mac: false };
				expect(hiddenFolder(sockets, home, ASKED, place)).toBeUndefined();
				expect(unfencedFolder(sockets, home, ASKED, place)).toContain(
					`which lies in ${sockets}, a path`,
				);
			} finally {
				vi.unstubAllEnvs();
			}
		},
	);

	it("names the closed path a folder lies in before one it holds", () => {
		const place = { treesRoot: join(home, "trees"), mac: false };
		expect(unfencedFolder(join(home, ".config"), home, ASKED, place)).toContain(
			`which lies in ${join(home, ".config")}, a path`,
		);
		expect(unfencedFolder(join(home, ".gsutil"), home, ASKED, place)).toContain(
			`which holds ${join(home, ".gsutil/credstore2")}, a path`,
		);
		expect(
			unfencedFolder(
				join(home, ".local/state/nix-offload"),
				home,
				ASKED,
				place,
			),
		).toContain(
			`which holds ${join(home, ".local/state/nix-offload/store_ed25519")}, a path`,
		);
	});

	it("follows a link into a closed path, a `..` named child too", () => {
		const place = { treesRoot: join(home, "trees"), mac: false };
		mkdirSync(join(home, ".config/inner"), { recursive: true });
		mkdirSync(join(home, ".config/..x"), { recursive: true });
		symlinkSync(join(home, ".config/inner"), join(home, "to-inner"));
		symlinkSync(join(home, ".config/..x"), join(home, "to-dotdot"));
		expect(
			unfencedFolder(join(home, "to-inner"), home, ASKED, place),
		).toContain(`which lies in ${join(home, ".config")}, a path`);
		expect(
			unfencedFolder(join(home, "to-dotdot"), home, ASKED, place),
		).toContain(`which lies in ${join(home, ".config")}, a path`);
	});

	it("names the closed path a link leads from, as a stowed dotfiles folder holds", () => {
		// From the home's real path, so the link's target is spelled as the
		// folder is, and could be named first.
		const at = realpathSync(home);
		const place = { treesRoot: join(at, "trees"), mac: false };
		const dotfiles = join(at, "src/dotfiles");
		mkdirSync(dotfiles, { recursive: true });
		writeFileSync(join(dotfiles, "zshrc"), "");
		symlinkSync(join(dotfiles, "zshrc"), join(at, ".zshrc"));
		expect(unfencedFolder(dotfiles, at, ASKED, place)).toContain(
			`which holds ${join(at, ".zshrc")}, a path`,
		);
	});

	it("names the closed path a link leads from though its target isn't written yet", () => {
		const at = realpathSync(home);
		const place = { treesRoot: join(at, "trees"), mac: false };
		const dots = join(at, "dots");
		mkdirSync(dots);
		// A command writing the target would land a startup file the shell runs.
		symlinkSync(join(dots, "bashrc"), join(at, ".bashrc"));
		expect(unfencedFolder(dots, at, ASKED, place)).toContain(
			`which holds ${join(at, ".bashrc")}, a path`,
		);
	});

	it("keeps pi's file tools from reading where a link to npm's or Docker's config leads", () => {
		const at = realpathSync(home);
		const place = { treesRoot: join(at, "trees"), mac: false };
		for (const [config, target] of [
			[".npmrc", "npm"],
			[".docker/config.json", "docker"],
		] as const) {
			const dots = join(at, "dots", target);
			mkdirSync(dots, { recursive: true });
			mkdirSync(dirname(join(at, config)), { recursive: true });
			writeFileSync(join(dots, "config"), "");
			symlinkSync(join(dots, "config"), join(at, config));
			// The fence hands its commands a copy without the tokens.
			expect(hiddenFolder(dots, at, ASKED, place), config).toContain(
				`which holds ${join(at, config)}, a path the fence hides`,
			);
		}
	});

	it("refuses the trees' own folder reached through a link, and spares a tree in it", () => {
		const trees = join(home, ".local/state/pi/agentic-harness.pi/work/trees");
		mkdirSync(join(trees, "t"), { recursive: true });
		symlinkSync(trees, join(home, "to-trees"));
		const place = { treesRoot: trees, mac: false };
		expect(
			unfencedFolder(join(home, "to-trees"), home, ASKED, place),
		).toContain("hides or keeps read-only");
		expect(
			unfencedFolder(join(home, "to-trees/t"), home, ASKED, place),
		).toBeUndefined();
	});

	it("folds case on a Mac, and closes its own paths there alone", () => {
		const mac = { treesRoot: join(home, "trees"), mac: true };
		const linux = { treesRoot: join(home, "trees"), mac: false };
		expect(unfencedFolder(join(home, ".CONFIG"), home, ASKED, mac)).toContain(
			`which lies in ${join(home, ".config")}, a path`,
		);
		const agents = join(home, "Library/LaunchAgents");
		expect(unfencedFolder(agents, home, ASKED, mac)).toContain(
			`which lies in ${agents}, a path`,
		);
		expect(unfencedFolder(agents, home, ASKED, linux)).toBeUndefined();
		// Followed as spelled, then folded: the link's name has capitals,
		// so folded first it would name no link and lead nowhere.
		mkdirSync(join(home, ".config/mac"), { recursive: true });
		symlinkSync(join(home, ".config/mac"), join(home, "To-Mac"));
		expect(unfencedFolder(join(home, "To-Mac"), home, ASKED, mac)).toContain(
			"a path the fence hides or keeps read-only",
		);
		expect(unfencedFolder("/opt/homebrew/bin", home, ASKED, mac)).toContain(
			"which lies in /opt/homebrew",
		);
		// The compiled code and the home folder, folded too; from a real
		// path, since a folder no disk holds is compared as spelled, and one
		// with capitals, so folding it changes it.
		const at = join(realpathSync(home), "Mac-Home");
		mkdirSync(at, { recursive: true });
		const cache = join(at, ".Cache/pi");
		expect(unfencedFolder(cache, at, ASKED, mac)).toContain("compiled");
		expect(unfencedFolder(cache, at, ASKED, linux)).toBeUndefined();
		expect(unfencedFolder(at.toLowerCase(), at, ASKED, mac)).toContain(
			"the home folder",
		);
	});

	it("spares a tree where the broker cuts them by default", () => {
		vi.stubEnv("XDG_STATE_HOME", join(home, ".local/state"));
		try {
			expect(unfencedFolder(join(cutTreeDir(), "t"), home)).toBeUndefined();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("leaves the temporary folder's code caches to a fence that lays its own, and no other", () => {
		const place = { treesRoot: join(home, "trees"), cachesClosed: true };
		expect(
			unfencedFolder("/tmp/jiti", home, ASKED, place),
			"jiti's cache, which the fence overlays",
		).toBeUndefined();
		expect(unfencedFolder("/tmp/jiti", home)).toContain("compiled");
		expect(
			unfencedFolder(join(home, ".cache"), home, ASKED, place),
			"the older install's cache, which no fence mount keeps",
		).toContain("compiled");
	});

	it("is one holding or inside the agent fence's own state", () => {
		for (const at of [
			".cache/pi-fence",
			".cache/pi-fence/homes",
			".cache/pi-fence/homes/cargo",
			".cache/pi-fence/gcloud/s-1",
		]) {
			expect(unfencedFolder(join(home, at), home), at).toContain("fence");
		}
	});

	it("names the sandbox as the variable that asks for it", () => {
		expect(ASKED).toBe(`${SANDBOX_VARIABLE}=${STRICT}`);
	});

	it("is one holding its repository's git folder, and not a worktree", () => {
		expect(unfencedFolder(join(home, "checkout"), home)).toContain("hooks");
		expect(unfencedFolder(join(home, "worktree"), home)).toBeUndefined();
		expect(unfencedFolder(join(home, "checkout/src"), home)).toBeUndefined();
	});

	it("is one whose .git file names a git folder inside it, as a bare repository's worktrees share, in ~/src too", () => {
		for (const proj of [
			join(home, "bare-proj"),
			join(home, "src/github.com/org/bare-proj"),
		]) {
			mkdirSync(join(proj, ".bare/objects"), { recursive: true });
			mkdirSync(join(proj, ".bare/worktrees/main"), { recursive: true });
			writeFileSync(join(proj, ".bare/HEAD"), "ref: refs/heads/main\n");
			writeFileSync(join(proj, ".git"), "gitdir: ./.bare\n");
			mkdirSync(join(proj, "main"));
			writeFileSync(
				join(proj, "main/.git"),
				`gitdir: ${join(proj, ".bare/worktrees/main")}\n`,
			);
			expect(unfencedFolder(proj, home), proj).toContain(
				"holds its repository's git folder",
			);
			expect(unfencedFolder(join(proj, "main"), home), proj).toBeUndefined();
		}
	});
});
