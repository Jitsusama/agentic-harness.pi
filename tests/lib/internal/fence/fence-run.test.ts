/**
 * pi-fence's run (lib/internal/fence/fence-run.ts): one command in pi's own
 * fence for a caller outside pi, the mycelium node's `runs` prefix
 * among them (ISXEG8, a735ba8b and 16931159; 04TNWT, c0c8f8fe).
 *
 * How it is asked is read first: the kind, the folder defaulting to the
 * working directory, the command's words kept whole after `--`. Then
 * what it refuses: the home folder, a folder holding it, one holding its
 * repository's git folder, and a machine that can't lay the fence. Then
 * real runs through bubblewrap and landrun, where this machine has both:
 * sockets served in a runtime folder of the test's own, a named and an
 * abstract one, are reached outside and refused inside, a home's secrets
 * can't be read, and only the folder can be written.
 */

import { execFile, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";

/** Whether the temporary folder's volume takes a name in other case as the same. */
function foldsCase(): boolean {
	const probe = mkdtempSync(join(tmpdir(), "fence-case-"));
	try {
		return existsSync(probe.toUpperCase());
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
}

import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	FENCE_RUN_HELP,
	type FenceRunAsk,
	fenceRunAsked,
	fenceRunText,
} from "../../../../lib/internal/fence/fence-run.ts";
import { sandboxFor } from "../../../../lib/internal/sandbox/sandbox.ts";

describe("reading how pi-fence was asked", () => {
	it("takes the working directory when no folder is named", () => {
		expect(fenceRunAsked(["--kind", "strict", "--", "true"], "/w")).toEqual({
			kind: "strict",
			folder: "/w",
			words: ["true"],
		});
	});

	it("takes --shared-tree as a flag alone, wherever it stands", () => {
		for (const options of [
			["--shared-tree", "--kind", "fence", "--folder", "/f"],
			["--kind", "fence", "--shared-tree", "--folder", "/f"],
			["--kind", "fence", "--folder", "/f", "--shared-tree"],
		]) {
			expect(fenceRunAsked([...options, "--", "true"], "/w")).toEqual({
				kind: "fence",
				folder: "/f",
				words: ["true"],
				shared: true,
			});
		}
	});

	it("keeps every word after -- as the command's, flags included", () => {
		const asked = fenceRunAsked(
			["--kind", "fence", "--folder", "/f", "--", "bash", "-lc", "ls --all"],
			"/w",
		);
		expect(asked).toEqual({
			kind: "fence",
			folder: "/f",
			words: ["bash", "-lc", "ls --all"],
		});
	});

	it("answers --help with its help, opening with its name, within 60 columns", () => {
		expect(fenceRunAsked(["--help"], "/w")).toEqual({ help: true });
		expect(FENCE_RUN_HELP.startsWith("pi-fence "), "opens with its name").toBe(
			true,
		);
		const wide = FENCE_RUN_HELP.split("\n").filter((line) => line.length > 60);
		expect(wide, "lines past 60 columns").toEqual([]);
	});

	it("reads a census, of /proc unless another is named", () => {
		expect(fenceRunAsked(["census"], "/w")).toEqual({ census: "/proc" });
		expect(fenceRunAsked(["census", "--proc", "/p"], "/w")).toEqual({
			census: "/p",
		});
		for (const args of [
			["census", "--proc"],
			["census", "--kind", "fence"],
		]) {
			expect(fenceRunAsked(args, "/w"), args.join(" ")).toHaveProperty("wrong");
		}
		expect(FENCE_RUN_HELP, "its help names it").toContain("pi-fence census");
	});

	it("says a census on a Mac can't judge, so its exit isn't read as sessions unfenced", () => {
		expect(FENCE_RUN_HELP.replace(/\s+/g, " ")).toContain(
			"Linux only: on macOS it can't judge and exits 1.",
		);
	});

	it("says what is wrong with a missing or unknown kind, a stray option or no command", () => {
		const wrongs = [
			["--", "true"],
			["--kind", "loose", "--", "true"],
			["--kind", "strict", "--where", "/f", "--", "true"],
			["--kind", "strict", "--"],
			["--kind", "strict", "true"],
		].map((args) => fenceRunAsked(args, "/w"));
		for (const wrong of wrongs) {
			expect(wrong, JSON.stringify(wrong)).toHaveProperty("wrong");
		}
		expect(JSON.stringify(wrongs[1]), "names the kinds").toContain(
			"fence or strict",
		);
	});
});

/** A fence laid by a machine with both programs, for the refusals' cases. */
const LAID = {
	kind: "fence",
	bwrap: "/run/current-system/sw/bin/bwrap",
	landrun: "/run/current-system/sw/bin/landrun",
} as const;

describe("refusing to run where the fence can't hold", () => {
	let base: string;
	let home: string;

	beforeAll(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "fr-")));
		home = join(base, "home");
		mkdirSync(join(home, "checkout", ".git"), { recursive: true });
	});

	afterAll(() => rmSync(base, { recursive: true, force: true }));

	const asking = (folder: string): FenceRunAsk => ({
		kind: "strict",
		folder,
		words: ["true"],
	});

	it("refuses the home folder, and a folder that holds it", () => {
		for (const folder of [home, base]) {
			const made = fenceRunText(asking(folder), {
				env: {},
				home,
				sandbox: LAID,
			});
			expect(made, folder).toHaveProperty("refused");
			expect(JSON.stringify(made), "says why").toContain("home folder");
		}
	});

	it("refuses a folder that holds its repository's git folder", () => {
		const made = fenceRunText(asking(join(home, "checkout")), {
			env: {},
			home,
			sandbox: LAID,
		});
		expect(JSON.stringify(made), "names the hooks").toContain("hooks");
	});

	it("refuses, saying why, where the machine can't lay the fence", () => {
		const made = fenceRunText(asking(join(base, "plain")), {
			env: {},
			home,
			sandbox: { kind: "refused", reason: "bwrap isn't installed" },
		});
		expect(made).toEqual({ refused: "bwrap isn't installed" });
	});

	it("refuses on a Mac without sandbox-exec, and the home folder there too", () => {
		const bare = fenceRunText(asking(join(base, "plain")), {
			env: {},
			home,
			platform: "darwin",
			sandboxExec: undefined,
		});
		const homed = fenceRunText(asking(home), {
			env: {},
			home,
			platform: "darwin",
			sandboxExec: "/usr/bin/sandbox-exec",
		});

		expect(JSON.stringify(bare), "names what is missing").toContain(
			"/usr/bin/sandbox-exec",
		);
		expect(bare).toHaveProperty("refused");
		expect(homed).toHaveProperty("refused");
	});

	it("holds the code caches on a Mac, the temporary folder's beside /tmp's, and their folders undeletable", () => {
		const made = fenceRunText(asking(join(base, "plain")), {
			env: {},
			home,
			platform: "darwin",
			sandboxExec: "/usr/bin/sandbox-exec",
			treesRoot: join(base, "trees"),
		});
		if (!("text" in made)) throw new Error(JSON.stringify(made));
		const own = join(realpathSync(tmpdir()), "jiti");
		const lines = made.text.split("\n");
		const naming = (folder: string) =>
			lines.filter((line) => line.includes(`"${folder}"`));
		for (const cache of ["/tmp/jiti", own]) {
			// Its own deny names it as a subpath, so it can be neither written
			// nor renamed (one not there is hidden whole); the folder above it
			// can't be renamed either.
			expect(
				naming(cache).some((line) =>
					/^\(deny (file-read\* )?file-write\*/.test(line),
				),
				`${cache} is kept from writes`,
			).toBe(true);
			expect(
				naming(dirname(cache)).some((line) =>
					line.startsWith("(deny file-write-unlink"),
				),
				`${dirname(cache)} can't be moved away`,
			).toBe(true);
		}
	});

	const onEither = (folder: string, platform: "linux" | "darwin") =>
		fenceRunText(
			{ kind: "fence", folder, words: ["true"] },
			{
				env: {},
				home,
				sandbox: LAID,
				platform,
				sandboxExec: "/usr/bin/sandbox-exec",
				treesRoot: join(base, "trees"),
			},
		);

	for (const [what, inside, platforms] of [
		["ssh's folder, so no key is read", ".ssh", ["linux", "darwin"]],
		["gpg's keys", ".gnupg/private-keys-v1.d", ["linux", "darwin"]],
		[
			"a folder in ~/.config, so git's settings and hooks stay",
			".config/git",
			["linux", "darwin"],
		],
		[
			"pi's own state",
			".local/state/pi/agentic-harness.pi",
			["linux", "darwin"],
		],
		["a keyring the fence hides", ".local/share/keyrings", ["linux", "darwin"]],
		["ssh's folder spelled in other case", ".SSH", ["darwin"]],
		["the Mac's mail", "Library/Mail", ["darwin"]],
		["mycelium's state", ".local/state/mycelium/work", ["darwin"]],
	] as const) {
		for (const platform of platforms) {
			it(`refuses a folder inside ${what}, on ${platform}`, () => {
				const made = fenceRunText(
					{ kind: "fence", folder: join(home, inside), words: ["true"] },
					{
						env: {},
						home,
						sandbox: LAID,
						platform,
						sandboxExec: "/usr/bin/sandbox-exec",
						treesRoot: join(base, "trees"),
					},
				);
				expect(JSON.stringify(made), "names the path").toContain(
					"hides or keeps read-only",
				);
			});
		}
	}

	it("refuses a folder that holds a path the fence keeps read-only", () => {
		const made = onEither(join(home, ".local"), "linux");
		expect(JSON.stringify(made), "names what it holds").toContain(
			`holds ${join(home, ".local")}`,
		);
	});

	it("refuses a folder inside a closed path reached through a link", () => {
		mkdirSync(join(base, "dotfiles", "config", "git"), { recursive: true });
		symlinkSync(join(base, "dotfiles", "config"), join(home, ".config"));
		try {
			const made = onEither(join(base, "dotfiles", "config", "git"), "linux");
			expect(JSON.stringify(made), "names where the link leads").toContain(
				`lies in ${join(base, "dotfiles", "config")}`,
			);
		} finally {
			rmSync(join(home, ".config"));
		}
	});

	it("runs beside a closed path that only shares its name's start", () => {
		for (const neighbour of [".ssh-old", ".local/state/pipx"]) {
			mkdirSync(join(home, neighbour), { recursive: true });
			const made = onEither(join(home, neighbour), "linux");
			expect(made, `${neighbour}: ${JSON.stringify(made)}`).toHaveProperty(
				"text",
			);
		}
	});

	it("refuses a folder that climbs out of the trees by name", () => {
		const trees = join(home, ".local/state/pi/agentic-harness.pi/work/trees");
		const made = fenceRunText(
			{ kind: "fence", folder: `${trees}/../../../b`, words: ["true"] },
			{ env: {}, home, sandbox: LAID, platform: "linux", treesRoot: trees },
		);
		expect(JSON.stringify(made), "isn't spared as a tree").toContain(
			"hides or keeps read-only",
		);
	});

	describe("a tree the work broker cut, in pi's state", () => {
		const within = (tree: string) =>
			join(home, ".local/state/pi/agentic-harness.pi/work/trees", tree);
		const inTree = (
			tree: string,
			held: readonly string[],
			shared?: boolean,
			platform: NodeJS.Platform = "darwin",
		) => {
			mkdirSync(tree, { recursive: true });
			return fenceRunText(
				{
					kind: "fence",
					folder: tree,
					words: ["true"],
					...(shared ? { shared } : {}),
				},
				{
					env: { PATH: "/usr/bin" },
					home,
					platform,
					...(platform === "darwin"
						? { sandboxExec: "/usr/bin/sandbox-exec" }
						: { sandbox: LAID }),
					treesRoot: within(""),
					heldTrees: held,
				},
			);
		};

		it("runs for the session holding it", () => {
			const tree = within("worktree-one");
			const made = inTree(join(tree, "src"), [tree]);
			expect(made, JSON.stringify(made)).toHaveProperty("text");
		});

		it("spares the same on Linux: the holder's and a shared one, no other", () => {
			const one = within("worktree-one");
			const held = inTree(one, [one], false, "linux");
			const other = inTree(within("worktree-two"), [one], false, "linux");
			const shared = inTree(within("worktree-three"), [], true, "linux");

			expect(held, JSON.stringify(held)).toHaveProperty("text");
			expect(JSON.stringify(other), "another's").toContain(
				"a work tree its asker doesn't hold",
			);
			expect(shared, JSON.stringify(shared)).toHaveProperty("text");
		});

		it("refuses another session's or quest's tree", () => {
			const made = inTree(within("worktree-two"), [within("worktree-one")]);
			expect(JSON.stringify(made), "says whose it is").toContain(
				"a work tree its asker doesn't hold",
			);
		});

		// On a volume that folds case the two names are one folder, so
		// only a case-sensitive one can hold the neighbour.
		it.skipIf(foldsCase())("spares no neighbour named in other case", () => {
			const made = inTree(within("worktree-r-Feature"), [
				within("worktree-r-feature"),
			]);
			expect(JSON.stringify(made), "another branch's tree").toContain(
				"a work tree its asker doesn't hold",
			);
		});

		describe("by the broker's records", () => {
			const inRecorded = (session: string, records: string) => {
				const tree = within("worktree-one");
				mkdirSync(tree, { recursive: true });
				return fenceRunText(
					{ kind: "fence", folder: tree, words: ["true"] },
					{
						env: { PATH: "/usr/bin", PI_SESSION_ID: session },
						home,
						platform: "darwin",
						sandboxExec: "/usr/bin/sandbox-exec",
						treesRoot: within(""),
						treeRecords: records,
					},
				);
			};
			const recorded = () => {
				const records = join(home, "records");
				mkdirSync(records, { recursive: true });
				writeFileSync(
					join(records, "one.json"),
					JSON.stringify({
						identity: { key: "one" },
						path: within("worktree-one"),
						providerId: "git-worktree",
						sessions: ["s1"],
					}),
				);
				return records;
			};

			it("runs for the session they say holds it", () => {
				const made = inRecorded("s1", recorded());
				expect(made, JSON.stringify(made)).toHaveProperty("text");
			});

			it("refuses a session they don't name", () => {
				const made = inRecorded("s2", recorded());
				expect(JSON.stringify(made), "another session's").toContain(
					"a work tree its asker doesn't hold",
				);
			});

			it("refuses, never crashes, when they can't be read", () => {
				const records = join(home, "records-file");
				writeFileSync(records, "not a folder");
				const made = inRecorded("s1", records);
				expect(JSON.stringify(made), "unread records hold nothing").toContain(
					`a work tree its asker doesn't hold (the work broker's records at ${records} couldn't be read`,
				);
			});

			it("says no session was named, when none was", () => {
				const made = inRecorded("", recorded());
				expect(JSON.stringify(made), "names the cause").toContain(
					"(no PI_SESSION_ID names its session)",
				);
			});
		});

		it("spares no tree for a record naming more than one", () => {
			const made = inTree(within("worktree-two"), [within("")]);
			expect(JSON.stringify(made), "the trees root isn't a tree").toContain(
				"a work tree its asker doesn't hold",
			);
		});

		it("lets --shared-tree open neither a closed path nor the trees root", () => {
			for (const folder of [join(home, ".ssh"), within("")]) {
				const made = fenceRunText(
					{ kind: "fence", folder, words: ["true"], shared: true },
					{ env: {}, home, sandbox: LAID, treesRoot: within("") },
				);
				expect(JSON.stringify(made), folder).toMatch(
					/a path the fence hides or keeps read-only/,
				);
			}
		});

		it("runs one the caller says was shared to its asker", () => {
			const made = inTree(within("worktree-three"), [], true);
			expect(made, JSON.stringify(made)).toHaveProperty("text");
		});
	});
});

describe("Linux's strict fence, for npm's and Docker's logins", () => {
	it("binds npm's copy over its settings and empties Docker's", () => {
		const own = realpathSync(mkdtempSync(join(tmpdir(), "fl-")));
		const home = join(own, "home");
		const work = join(home, "work");
		const runtime = join(own, "run");
		mkdirSync(join(home, ".docker"), { recursive: true });
		mkdirSync(work);
		mkdirSync(runtime);
		writeFileSync(
			join(home, ".npmrc"),
			"//npm.example/:_authToken=not-a-token\n",
		);
		writeFileSync(
			join(home, ".docker", "config.json"),
			JSON.stringify({ auths: { "ghcr.io": { auth: "bm90LWEtbG9naW4=" } } }),
		);
		try {
			const made = fenceRunText(
				{ kind: "strict", folder: work, words: ["true"] },
				{ env: { XDG_RUNTIME_DIR: runtime }, home, sandbox: LAID },
			);
			if (!("text" in made)) throw new Error(JSON.stringify(made));
			const copy = join(runtime, "pi-fence", "npmrc");

			expect(made.text).toContain(
				`'--ro-bind' '${copy}' '${join(home, ".npmrc")}'`,
			);
			expect(readFileSync(copy, "utf8")).not.toContain("not-a-token");
			expect(made.text).toContain(
				`'--ro-bind' '/dev/null' '${join(home, ".docker", "config.json")}'`,
			);

			// Settings naming no login stay, so a fenced docker still pulls.
			writeFileSync(
				join(home, ".docker", "config.json"),
				JSON.stringify({ credHelpers: { "gcr.io": "gcloud" } }),
			);
			const kept = fenceRunText(
				{ kind: "strict", folder: work, words: ["true"] },
				{ env: { XDG_RUNTIME_DIR: runtime }, home, sandbox: LAID },
			);
			expect(JSON.stringify(kept)).not.toContain(
				`'/dev/null' '${join(home, ".docker", "config.json")}'`,
			);
		} finally {
			rmSync(own, { recursive: true, force: true });
		}
	});
});

/** curl, as the store has it, for a fenced command to connect with. */
function storeCurl(): string | undefined {
	const found = spawnSync("bash", ["-c", "command -v curl"], {
		encoding: "utf8",
	}).stdout.trim();
	return found ? realpathSync(found) : undefined;
}

/** Whether this machine can lay the fence: Linux, with both programs. */
function fenceLaid(): boolean {
	const sandbox = sandboxFor({ PI_SANDBOX: "fence" });
	if (sandbox.kind !== "fence") return false;
	const tried = spawnSync(sandbox.landrun, ["--rwx", "/", "--", "true"]);
	return tried.status === 0;
}

const curl = storeCurl();

/** curl's exit status when it couldn't connect at all. */
const COULDNT_CONNECT = 7;

/** What a program run to its end said, and its status; null when it was stopped. */
interface Ran {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * Runs `program` in `cwd` without blocking, since the sockets it
 * connects to are served by this same process.
 */
function ran(
	program: string,
	args: readonly string[],
	cwd: string,
): Promise<Ran> {
	return new Promise((settle) => {
		execFile(
			program,
			[...args],
			{ cwd, timeout: 30_000, encoding: "utf8" },
			(error, stdout, stderr) => {
				const code =
					error && typeof error.code === "number"
						? error.code
						: error
							? null
							: 0;
				settle({ status: code, stdout, stderr });
			},
		);
	});
}

/** A socket served at `path`, an abstract one when it begins with a NUL. */
function serve(path: string): Promise<Server> {
	return new Promise((settle, fail) => {
		// It answers before it closes: curl reads a connection reset at
		// once as one it couldn't make, about one try in six.
		const server = createServer((socket) => {
			socket.on("error", () => {
				// A client gone first leaves nothing to answer.
			});
			socket.once("data", () => socket.end("HTTP/1.0 204 No Content\r\n\r\n"));
		});
		server.once("error", fail);
		server.listen(path, () => settle(server));
	});
}

describe.skipIf(curl === undefined || !fenceLaid())(
	"running through pi-fence's strict fence",
	() => {
		let base: string;
		let home: string;
		let runtimeDir: string;
		let folder: string;
		let beside: string;
		const abstract = `pi-fence-test-${process.pid}`;
		const named = ["bus", "wayland-1", "mycelium/work.sock", "agent.sock"];
		const servers: Server[] = [];

		/** Runs `words` through pi-fence's strict fence, as the script does. */
		const fencedRun = (words: readonly string[]) => {
			const made = fenceRunText(
				{ kind: "strict", folder, words },
				{ env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir }, home },
			);
			if ("refused" in made) throw new Error(made.refused);
			return ran("bash", ["-c", made.text], made.folder);
		};
		const reached = (status: number | null) =>
			status !== null && status !== COULDNT_CONNECT;
		const probe = (path: string) =>
			path.startsWith("@")
				? [
						curl ?? "curl",
						"-sS",
						"--abstract-unix-socket",
						path.slice(1),
						"http://x/",
					]
				: [curl ?? "curl", "-sS", "--unix-socket", path, "http://x/"];

		beforeAll(async () => {
			// Not resolved further: a Unix socket's path may be at most 107
			// bytes, and a temporary folder can sit behind a long link.
			base = mkdtempSync(join(tmpdir(), "fr-"));
			home = join(base, "h");
			runtimeDir = join(base, "r");
			folder = join(base, "work");
			beside = join(base, "beside");
			for (const made of [runtimeDir, folder, beside]) {
				mkdirSync(made, { recursive: true, mode: 0o700 });
			}
			mkdirSync(join(home, ".ssh"), { recursive: true });
			mkdirSync(join(home, ".config", "gh"), { recursive: true });
			writeFileSync(join(home, ".ssh", "id_ed25519"), "secret key\n");
			writeFileSync(join(home, ".config", "gh", "hosts.yml"), "token\n");
			for (const name of named) {
				const path = join(runtimeDir, name);
				mkdirSync(dirname(path), { recursive: true });
				servers.push(await serve(path));
			}
			servers.push(await serve(`\0${abstract}`));
		});

		afterAll(async () => {
			await Promise.all(
				servers.map((server) => new Promise((settle) => server.close(settle))),
			);
			rmSync(base, { recursive: true, force: true });
		});

		it("reaches none of the runtime folder's sockets, nor an abstract one, that answer outside", async () => {
			const paths = [
				...named.map((name) => join(runtimeDir, name)),
				`@${abstract}`,
			];
			for (const path of paths) {
				const [program, ...rest] = probe(path);
				const outside = await ran(program ?? "curl", rest, base);
				expect(
					reached(outside.status),
					`${path} answers outside: ${outside.status} ${outside.stderr}`,
				).toBe(true);
				expect(
					reached((await fencedRun(probe(path))).status),
					`a fenced command reached ${path}`,
				).toBe(false);
			}
		});

		it("can't read the home's SSH key or gh's sign-in", async () => {
			for (const secret of [".ssh/id_ed25519", ".config/gh/hosts.yml"]) {
				const read = await fencedRun(["cat", join(home, secret)]);
				expect(read.stdout, `${secret} was read inside`).not.toContain(
					secret.startsWith(".ssh") ? "secret key" : "token",
				);
				expect(read.status, `${secret} was read inside`).not.toBe(0);
			}
		});

		it("writes the folder, and nowhere beside it", async () => {
			const wrote = await fencedRun(["touch", join(folder, "made")]);
			expect(wrote.status, wrote.stderr).toBe(0);
			expect(existsSync(join(folder, "made")), "the folder's write").toBe(true);
			await fencedRun(["touch", join(beside, "made")]);
			expect(
				existsSync(join(beside, "made")),
				"a fenced command wrote outside its folder",
			).toBe(false);
		});

		it("passes the command's own status back", async () => {
			expect((await fencedRun(["bash", "-c", "exit 3"])).status).toBe(3);
		});
	},
);
