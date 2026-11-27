/**
 * The repository homes the person's settings name outside the home
 * folder: which are kept and which refused, and that the fence's git
 * guard and walk take each one kept as they take `~/src`.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fenceArgs,
	gitFolders,
	guardsGitFolder,
} from "../../../../lib/internal/fence/fence.ts";
import {
	type NamedHomeDisk,
	namedHomeDoubt,
	namedRepositoryHomes,
	readNamedHomes,
} from "../../../../lib/internal/fence/fence-repository-homes.ts";
import { unfencedFolder } from "../../../../lib/internal/sandbox/unfenced-folder.ts";

/**
 * The fence and its named homes as a new pi process loads them, with no
 * read of its own yet: what one process read, another doesn't know.
 */
async function anotherProcess() {
	vi.resetModules();
	const fence = await import("../../../../lib/internal/fence/fence.ts");
	return { guardsGitFolder: fence.guardsGitFolder };
}

/** Where pi records which folder each named home first was, under `home`. */
function records(home: string): string {
	return join(home, ".local", "state", "pi", "agentic-harness.pi", "fence");
}

/** Write the person's settings under `home`, naming `homes`. */
function naming(home: string, homes: unknown): void {
	const folder = join(home, ".config", "pi", "agentic-harness.pi");
	mkdirSync(folder, { recursive: true });
	writeFileSync(
		join(folder, "config.json"),
		JSON.stringify({
			version: 1,
			sections: { fence: { repositoryHomes: homes } },
		}),
	);
}

/** A plain repository's git folder at `path`, as a clone leaves one. */
function repository(path: string): string {
	const git = join(path, ".git");
	for (const folder of ["objects", "refs", "hooks", "info"]) {
		mkdirSync(join(git, folder), { recursive: true });
	}
	writeFileSync(join(git, "HEAD"), "ref: refs/heads/main\n");
	writeFileSync(join(git, "config"), "[core]\n");
	return git;
}

/** A bubblewrap on `PATH` that can make a namespace here, or nothing. */
function workingBwrap(): string | undefined {
	const found = spawnSync("bash", ["-c", "command -v bwrap"], {
		encoding: "utf8",
	}).stdout.trim();
	if (!found) return undefined;
	const tried = spawnSync(found, [
		"--unshare-user",
		"--ro-bind",
		"/",
		"/",
		"true",
	]);
	return tried.status === 0 ? found : undefined;
}

/**
 * A disk holding these folders and links, every path its own real one,
 * where a folder can be made only in `makeable`.
 */
function standIn(
	folders: readonly string[],
	links: readonly string[] = [],
	real: Record<string, string> = {},
	makeable: readonly string[] = [],
): NamedHomeDisk {
	const there = [...folders];
	return {
		kind: (path) =>
			there.includes(path)
				? "folder"
				: links.includes(path)
					? "link"
					: undefined,
		real: (path) => real[path] ?? path,
		make: (path) => {
			if (!makeable.includes(path)) return false;
			there.push(path);
			return true;
		},
		identity: (path) => (there.includes(path) ? path : undefined),
	};
}

describe("the repository homes the person's settings name", () => {
	let home: string;
	beforeEach(() => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "named-homes-")));
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	const read = (disk: NamedHomeDisk, platform: NodeJS.Platform = "linux") =>
		readNamedHomes(home, {
			platform,
			install: "/opt/harness",
			own: ["/world/cache/pi"],
			disk,
		});

	// F48, F60: the fence binds a quest's scratch and the session's trees
	// back writable there, a writable spot in a home the guard trusts.
	it("refuses a home holding or lying in pi's own cache and state", () => {
		naming(home, ["/world", "/world/cache/pi/trees"]);
		const disk = standIn([home, "/world", "/world/cache/pi/trees"]);
		expect(read(disk).homes, "no home is kept").toEqual([]);
		expect(read(disk).refused, "each is said").toEqual([
			"/world holds or lies in /world/cache/pi, pi's own folder, where the fence lets commands write",
			"/world/cache/pi/trees holds or lies in /world/cache/pi, pi's own folder, where the fence lets commands write",
		]);
	});

	it("keeps a plain folder outside the home folder, once however often it's named", () => {
		naming(home, ["/world/runs/a/src", "/world/runs/a/src"]);
		const disk = standIn([home, "/world/runs/a/src"]);
		expect(read(disk), "the named folder is kept, once").toEqual({
			homes: ["/world/runs/a/src"],
			refused: [],
		});
	});

	it("names nothing where the settings name nothing, or don't parse", () => {
		expect(read(standIn([home])), "no settings file names none").toEqual({
			homes: [],
			refused: [],
		});
		naming(home, undefined);
		expect(read(standIn([home])).homes, "no fence section names none").toEqual(
			[],
		);
		writeFileSync(
			join(home, ".config", "pi", "agentic-harness.pi", "config.json"),
			'{"sections": {"fence": {"repositoryHomes": ["/world/runs"]',
		);
		expect(
			read(standIn([home, "/world/runs"])),
			"a file that doesn't parse names none",
		).toEqual({ homes: [], refused: [] });
	});

	// A missing home's parent is writable to a fenced command, which could
	// make the home and fill it for git outside the fence to trust.
	it("makes a missing home, and refuses one pi can't make", () => {
		naming(home, ["/world/runs/new", "/world/runs/gone"]);
		const disk = standIn([home], [], {}, ["/world/runs/new"]);
		expect(read(disk), "the one made is kept").toEqual({
			homes: ["/world/runs/new"],
			refused: ["/world/runs/gone is missing, and pi can't make it"],
		});
		expect(disk.kind("/world/runs/new"), "it was made").toBe("folder");
	});

	it("makes no home it refuses", () => {
		naming(home, [join(home, "src", "new")]);
		const disk = standIn([home], [], {}, [join(home, "src", "new")]);
		read(disk);
		expect(disk.kind(join(home, "src", "new")), "nothing made").toBe(undefined);
	});

	it("refuses the disk, the home folder, a folder above or in it, and the harness's install", () => {
		naming(home, [
			"/",
			home,
			join(home, "src", "more"),
			join(home, ".local", "state"),
			dirname(home),
			"/opt/harness/lib",
			"/opt",
		]);
		const disk = standIn([
			"/",
			home,
			dirname(home),
			"/opt",
			"/opt/harness/lib",
		]);
		const { homes, refused } = read(disk);
		expect(homes, "none is kept").toEqual([]);
		expect(refused, "each is refused with its reason").toEqual([
			"/ is the whole disk",
			`${home} is the home folder, in it or above it, which the fence lays itself`,
			`${join(home, "src", "more")} is the home folder, in it or above it, which the fence lays itself`,
			`${join(home, ".local", "state")} is the home folder, in it or above it, which the fence lays itself`,
			`${dirname(home)} is the home folder, in it or above it, which the fence lays itself`,
			"/opt/harness/lib holds or lies in the harness's own install",
			"/opt holds or lies in the harness's own install",
		]);
	});

	it("refuses a home folder's real place too, where the home folder is a link", () => {
		naming(home, ["/data/me/src"]);
		const disk = standIn(["/data/me/src"], [], { [home]: "/data/me" });
		const kind = disk.kind;
		disk.kind = (path) => (path === home ? "link" : kind(path));
		expect(read(disk).refused, "the followed home's inside is refused").toEqual(
			[
				"/data/me/src is the home folder, in it or above it, which the fence lays itself",
			],
		);
	});

	it("refuses what isn't a whole, plainly written path, or isn't a path", () => {
		naming(home, ["world/runs", "/world/../etc", "/world/runs/", 7]);
		const { homes, refused } = read(standIn([home, "/etc", "/world/runs"]));
		expect(homes, "none is kept").toEqual([]);
		expect(refused, "each is refused with its reason").toEqual([
			"world/runs is not a whole path written plainly",
			"/world/../etc is not a whole path written plainly",
			"/world/runs/ is not a whole path written plainly",
			"7 is no path",
		]);
	});

	it("refuses a link, and a folder reached past one", () => {
		naming(home, ["/world/link", "/world/past/src"]);
		const disk = standIn([home, "/world/past/src"], ["/world/link"], {
			"/world/past/src": "/elsewhere/src",
		});
		expect(read(disk), "both are refused").toEqual({
			homes: [],
			refused: ["/world/link is a link", "/world/past/src lies past a link"],
		});
	});

	it("refuses every home off Linux, whose fence keeps nothing outside the home folder read-only", () => {
		naming(home, ["/world/runs"]);
		expect(
			read(standIn([home, "/world/runs"]), "darwin"),
			"a Mac keeps none",
		).toEqual({
			homes: [],
			refused: [
				"/world/runs is outside the home folder, which only Linux's fence keeps read-only",
			],
		});
	});
});

describe.skipIf(process.platform !== "linux")(
	"a named home's repositories, as the fence's git guard sees them",
	() => {
		let home: string;
		let runs: string;
		beforeEach(() => {
			home = realpathSync(mkdtempSync(join(tmpdir(), "named-guard-")));
			runs = realpathSync(mkdtempSync(join(tmpdir(), "named-runs-")));
		});
		afterEach(() => {
			rmSync(home, { recursive: true, force: true });
			rmSync(runs, { recursive: true, force: true });
		});

		it("guards and lists a clone in a named home as one in ~/src", () => {
			const git = repository(join(runs, "github.com", "o", "r"));
			naming(home, [runs]);
			expect(guardsGitFolder(git, home), "the clone is guarded").toBe(true);
			expect(gitFolders(home), "the walk finds it").toContain(git);
		});

		it("guards nothing in a folder the settings don't name", () => {
			const git = repository(join(runs, "github.com", "o", "r"));
			expect(guardsGitFolder(git, home), "an unnamed clone is unguarded").toBe(
				false,
			);
			expect(gitFolders(home), "the walk passes it by").not.toContain(git);
		});

		// F25, F29, F34, F41: gone and made again, by a command while it was
		// gone or by anyone, it may hold a repository nobody vouches for.
		it("guards nothing in a named home put back since pi first read it", () => {
			const named = join(runs, "src");
			const git = repository(join(named, "o", "r"));
			naming(home, [named]);
			expect(guardsGitFolder(git, home), "guarded as first read").toBe(true);
			rmSync(named, { recursive: true });
			repository(join(named, "o", "r"));
			expect(guardsGitFolder(git, home), "the one put back is unguarded").toBe(
				false,
			);
		});

		// F50: the first read made before the folder goes, so fenceArgs's own
		// read can't be what makes it.
		it("makes a named home gone since the first read before a command starts", () => {
			const named = join(runs, "src");
			mkdirSync(named);
			naming(home, [named]);
			expect(namedRepositoryHomes(home), "read first").toEqual([named]);
			rmSync(named, { recursive: true });
			fenceArgs({ home, runtimeDir: undefined });
			expect(existsSync(named), "made again").toBe(true);
		});

		// F46, F53, F58, F63: each process once trusted what it saw first.
		it("guards nothing in a named home put back, in a process that never read it before", async () => {
			const named = join(runs, "src");
			const git = repository(join(named, "o", "r"));
			naming(home, [named]);
			expect(guardsGitFolder(git, home), "guarded as first read").toBe(true);
			rmSync(named, { recursive: true });
			repository(join(named, "o", "r"));
			const later = await anotherProcess();
			expect(
				later.guardsGitFolder(git, home),
				"a later process trusts the one put back",
			).toBe(false);
		});

		// F63, F64: a home pi couldn't make was left unbound, and its parent
		// writable, so whatever made it later may be a command.
		it("guards nothing in a named home that turned up where pi found none", async () => {
			const parent = join(runs, "parent");
			const named = join(parent, "src");
			mkdirSync(parent, { mode: 0o555 });
			naming(home, [named]);
			try {
				expect(namedRepositoryHomes(home), "pi can't make it").toEqual([]);
			} finally {
				chmodSync(parent, 0o755);
			}
			const git = repository(join(named, "o", "r"));
			const later = await anotherProcess();
			expect(
				later.guardsGitFolder(git, home),
				"a later process trusts what turned up",
			).toBe(false);
		});

		// F63: a process read the settings once, so a home named after went
		// unbound for as long as it lived.
		it("reads a home named after the first read", () => {
			naming(home, []);
			expect(namedRepositoryHomes(home), "none named yet").toEqual([]);
			naming(home, [runs]);
			expect(namedRepositoryHomes(home), "named since").toEqual([runs]);
		});

		// F67: refused for good, with a way back the person can take.
		it("says how to trust a home put back again, and trusts it once its record is gone", () => {
			const named = join(runs, "src");
			const git = repository(join(named, "o", "r"));
			naming(home, [named]);
			expect(namedHomeDoubt(home, named), "no doubt at first").toBeUndefined();
			rmSync(named, { recursive: true });
			repository(join(named, "o", "r"));
			expect(namedHomeDoubt(home, named), "the way back").toContain(
				records(home),
			);
			expect(guardsGitFolder(git, home), "unguarded until then").toBe(false);
			rmSync(records(home), { recursive: true });
			expect(guardsGitFolder(git, home), "guarded as it now stands").toBe(true);
		});

		// F57: a strict session there could write every clone in it.
		it("lets no unfenced session write a folder holding a named home", () => {
			const named = join(runs, "src");
			mkdirSync(named);
			expect(unfencedFolder(runs, home), "unnamed, it may").toBeUndefined();
			naming(home, [named]);
			expect(unfencedFolder(runs, home), "named, it may not").toContain(
				`${named}, a repository home the person's settings name`,
			);
		});

		// F32, F55: the bound itself, as `~/src` has it.
		it("guards a clone at ~/src's own depth", () => {
			const git = repository(join(runs, "a", "b", "c", "d"));
			naming(home, [runs]);
			expect(guardsGitFolder(git, home), "a clone four deep").toBe(true);
		});

		it("guards nothing deeper than ~/src's own depth", () => {
			const git = repository(join(runs, "a", "b", "c", "d", "e"));
			naming(home, [runs]);
			expect(guardsGitFolder(git, home), "too deep a clone is unguarded").toBe(
				false,
			);
		});
	},
);

const bwrap = workingBwrap();

describe.skipIf(bwrap === undefined)(
	"what a fenced command can write in a named home, through a real bubblewrap",
	() => {
		let home: string;
		let runs: string;
		let temp: string;
		beforeEach(() => {
			home = realpathSync(mkdtempSync(join(tmpdir(), "named-fence-")));
			runs = realpathSync(mkdtempSync(join(tmpdir(), "named-fence-runs-")));
			temp = realpathSync(mkdtempSync(join(tmpdir(), "named-fence-tmp-")));
			mkdirSync(join(home, ".cache"));
			naming(home, [runs]);
		});
		afterEach(() => {
			for (const folder of [home, runs, temp]) {
				rmSync(folder, { recursive: true, force: true });
			}
		});

		/** bubblewrap's words for `script` as a fenced command in `home`. */
		const fencedWords = (script: string) => [
			"--unshare-user",
			...fenceArgs({
				home,
				runtimeDir: undefined,
				tempCaches: [join(temp, "compiled"), join(temp, "jiti")],
			}),
			"sh",
			"-c",
			script,
		];
		const fenced = (script: string) =>
			spawnSync(bwrap ?? "bwrap", fencedWords(script)).status === 0;

		it("makes nothing new in the named home", () => {
			const made = join(runs, "made");
			expect(fenced(`mkdir ${made}`), "a folder was made").toBe(false);
			expect(existsSync(made), `${made} is there`).toBe(false);
		});

		// F41: its parent is writable, so the home must stand before it runs.
		it("makes no repository in a named home missing when pi first read it", () => {
			const named = join(runs, "later");
			naming(home, [named]);
			expect(
				fenced(`mkdir -p ${named}/o/r/.git/hooks`),
				"a repository was made",
			).toBe(false);
			expect(existsSync(join(named, "o")), "something is in it").toBe(false);
		});

		it("keeps a clone's hooks and settings read-only, and writes what a commit writes", () => {
			const git = repository(join(runs, "github.com", "o", "r"));
			expect(fenced(`echo x > ${git}/hooks/pre-commit`), "a hook").toBe(false);
			expect(fenced(`echo x >> ${git}/config`), "its settings").toBe(false);
			expect(fenced(`echo x > ${git}/info/attributes`), "attributes").toBe(
				false,
			);
			expect(fenced(`touch ${git}/objects/made`), "an object").toBe(true);
		});

		it("moves no folder above a named home, so no repository stands in its place", () => {
			const named = join(runs, "parent", "home");
			repository(join(named, "o", "r"));
			naming(home, [named]);
			for (const folder of [join(runs, "parent"), runs]) {
				expect(fenced(`mv ${folder} ${folder}-moved`), `${folder} moved`).toBe(
					false,
				);
			}
			expect(
				existsSync(join(named, "o", "r", ".git", "HEAD")),
				"the named home's clone is gone",
			).toBe(true);
		});

		it("lays the fence's own mounts over a named home that holds where it lays them", () => {
			const runtime = join(runs, "runtime");
			mkdirSync(runtime);
			writeFileSync(join(runtime, "host-socket"), "");
			const words = [
				"--unshare-user",
				...fenceArgs({ home, runtimeDir: runtime }),
				"sh",
				"-c",
				`test ! -e ${runtime}/host-socket`,
			];
			const ran = spawnSync(bwrap ?? "bwrap", words, { encoding: "utf8" });
			expect(ran.status, `the host's socket shows: ${ran.stderr}`).toBe(0);
		});

		// Up to 10 s for the fence to start under load, past vitest's 5 s.
		it("keeps a repository cloned there while a command runs read-only to it, hooks and all", {
			timeout: 20_000,
		}, async () => {
			const ready = join(home, ".cache", "ready");
			const go = join(temp, "go");
			const late = join(runs, "github.com", "o", "late", ".git");
			// The command says it's fenced, then waits for the clone outside,
			// looking every 50 ms, which is all the shell can wait on.
			const script = `touch ${ready}; while [ ! -e ${go} ]; do sleep 0.05; done; echo x > ${late}/hooks/pre-commit`;
			const child = spawn(bwrap ?? "bwrap", fencedWords(script));
			const ended = new Promise<number | null>((done) =>
				child.on("exit", (code) => done(code)),
			);
			try {
				await vi.waitFor(() => expect(existsSync(ready), "fenced").toBe(true), {
					timeout: 10_000,
					interval: 20,
				});
				repository(dirname(late));
				writeFileSync(go, "");
				expect(await ended, "the hook's write succeeded").not.toBe(0);
			} finally {
				// A command still looping, when the fence never started, is ended.
				child.kill("SIGKILL");
			}
			expect(
				existsSync(join(late, "hooks", "pre-commit")),
				"the hook is there",
			).toBe(false);
		});
	},
);
