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
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	FENCE_RUN_HELP,
	type FenceRunAsk,
	fenceRunAsked,
	fenceRunText,
} from "../../../../lib/internal/fence/fence-run.ts";
import { sandboxFor } from "../../../../lib/internal/sandbox.ts";

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
		const bare = fenceRunText(
			{ ...asking(join(base, "plain")), kind: "fence" },
			{
				env: {},
				home,
				platform: "darwin",
				sandboxExec: undefined,
			},
		);
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
			expect(JSON.stringify(made), "names the link's own path").toContain(
				"hides or keeps read-only",
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
					platform: "darwin",
					sandboxExec: "/usr/bin/sandbox-exec",
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

		it("refuses another session's or quest's tree", () => {
			const made = inTree(within("worktree-two"), [within("worktree-one")]);
			expect(JSON.stringify(made), "says whose it is").toContain(
				"a work tree its asker doesn't hold",
			);
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

/** A file rule in a sandbox-exec profile: what it does, to which operations, on which path. */
const RULE =
	/^\((allow|deny) ((?:[a-z-]+\* )+)\((subpath|literal) "([^"]*)"\)\)$/;

/**
 * The rule that decides `op` on `target` in the profile a Mac's fenced
 * command runs under, as sandbox-exec reads it: the last that matches.
 * None means the profile's `(allow default)`.
 */
function deciding(
	text: string,
	target: string,
	op: "file-read*" | "file-write*",
): string | undefined {
	const lines = (text.split("\nexec ")[1] ?? "").split("\n");
	const matching = lines.filter((line) => {
		const [, , ops = "", kind, path = ""] = RULE.exec(line) ?? [];
		if (!ops.split(" ").includes(op)) return false;
		return kind === "literal"
			? target === path
			: target === path || target.startsWith(`${path}/`);
	});
	return matching[matching.length - 1];
}

describe("the fence on a Mac", () => {
	let home: string;
	let folder: string;

	beforeAll(() => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "fm-")));
		folder = join(home, "work");
		mkdirSync(join(home, ".ssh"), { recursive: true });
		mkdirSync(join(home, ".cache"), { recursive: true });
		mkdirSync(folder, { recursive: true });
	});

	afterAll(() => rmSync(home, { recursive: true, force: true }));

	const onMac = (kind: FenceRunAsk["kind"]) => {
		const made = fenceRunText(
			{ kind, folder, words: ["echo", "it's here"] },
			{
				env: {},
				home,
				platform: "darwin",
				sandboxExec: "/usr/bin/sandbox-exec",
			},
		);
		if (!("text" in made)) throw new Error(JSON.stringify(made));
		return made.text;
	};

	it("tries the profile first and refuses with 126 when it doesn't apply", () => {
		const text = onMac("fence");

		expect(text).toMatch(
			/^unset SSH_AUTH_SOCK\n'\/usr\/bin\/sandbox-exec' -p '\(version 1\)[^']*' \/usr\/bin\/true \|\| \{ [^\n]* exit 126; \}\nexec '\/usr\/bin\/sandbox-exec' -p '\(version 1\)[^']*' \/bin\/bash -c /,
		);
	});

	it("hides ~/.ssh and keeps home's visible entries read-only but the folder's", () => {
		const text = onMac("fence");

		expect(text).toContain(
			`(deny file-read* file-write* (subpath "${join(home, ".ssh")}"))`,
		);
		expect(text).toContain(`(deny file-write* (subpath "${home}"))`);
		expect(text).toContain(
			`(allow file-read* file-write* (subpath "${folder}"))`,
		);
	});

	it("sends no Apple Event, and points caches where the fence lets them write", () => {
		const text = onMac("fence");

		// The command is quoted again inside bash -c, and its quotes with it.
		const within = (words: string) => words.replaceAll("'", "'\\''");

		expect(text).toContain("(deny appleevent-send)");
		expect(text).toContain(
			within(
				`[ -n "\${XDG_CACHE_HOME:-}" ] || export XDG_CACHE_HOME='${join(home, ".cache")}'`,
			),
		);
		expect(text).toContain(
			within(
				`[ -n "\${GOCACHE:-}" ] || export GOCACHE='${join(home, ".cache", "go-build")}'`,
			),
		);
		expect(text).toContain(
			`(allow file-read* file-write* (subpath "${join(home, ".cache")}"))`,
		);
	});

	it("leaves caches be where strict keeps them read-only, or ~/.cache isn't there, and execs the command", () => {
		const within = (words: string) => words.replaceAll("'", "'\\''");
		const bare = realpathSync(mkdtempSync(join(tmpdir(), "fm-bare-")));
		mkdirSync(join(bare, "work"));
		try {
			const made = fenceRunText(
				{ kind: "fence", folder: join(bare, "work"), words: ["true"] },
				{
					env: {},
					home: bare,
					platform: "darwin",
					sandboxExec: "/usr/bin/sandbox-exec",
				},
			);
			expect(JSON.stringify(made)).not.toContain("XDG_CACHE_HOME");
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}

		expect(onMac("strict")).not.toContain("XDG_CACHE_HOME");
		expect(onMac("fence")).toContain(within("; exec 'echo' "));
	});

	it("reads npm's settings only as the copy without tokens, and empties Docker's logins", () => {
		const own = realpathSync(mkdtempSync(join(tmpdir(), "fm-own-")));
		const work = join(own, "work");
		mkdirSync(work);
		mkdirSync(join(own, ".docker"));
		writeFileSync(
			join(own, ".npmrc"),
			"//npm.example/:_authToken=not-a-token\n",
		);
		writeFileSync(
			join(own, ".docker", "config.json"),
			JSON.stringify({ auths: { "ghcr.io": { auth: "bm90LWEtbG9naW4=" } } }),
		);
		const temporary = join(own, "tmp");
		mkdirSync(temporary);
		try {
			const made = fenceRunText(
				{ kind: "fence", folder: work, words: ["npm", "ping"] },
				{
					env: { TMPDIR: temporary },
					home: own,
					platform: "darwin",
					sandboxExec: "/usr/bin/sandbox-exec",
				},
			);
			if (!("text" in made)) throw new Error(JSON.stringify(made));
			const copy = /export NPM_CONFIG_USERCONFIG='\\''([^']+)'\\''/.exec(
				made.text,
			)?.[1];
			expect(copy, "npm is pointed at a copy").toBeDefined();
			expect(readFileSync(copy ?? "", "utf8")).not.toContain("not-a-token");
			expect(made.text).toContain(
				`(deny file-write* (subpath "${dirname(copy ?? "")}"))`,
			);
			for (const hidden of [".npmrc", ".docker/config.json"]) {
				expect(made.text).toContain(
					`(deny file-read* file-write* (literal "${join(own, hidden)}"))`,
				);
			}
		} finally {
			rmSync(own, { recursive: true, force: true });
		}
	});

	it("writes npm's copy over a link put in its place, never through it", () => {
		const own = realpathSync(mkdtempSync(join(tmpdir(), "fm-link-")));
		const work = join(own, "work");
		const temporary = join(own, "tmp");
		const victim = join(own, "victim");
		mkdirSync(work);
		mkdirSync(join(temporary, "pi-fence"), { recursive: true });
		writeFileSync(
			join(own, ".npmrc"),
			"//npm.example/:_authToken=not-a-token\n",
		);
		writeFileSync(victim, "the person's own\n");
		symlinkSync(victim, join(temporary, "pi-fence", "npmrc"));
		try {
			const made = fenceRunText(
				{ kind: "fence", folder: work, words: ["true"] },
				{
					env: { TMPDIR: temporary },
					home: own,
					platform: "darwin",
					sandboxExec: "/usr/bin/sandbox-exec",
				},
			);
			const replaced = lstatSync(join(temporary, "pi-fence", "npmrc"));

			expect(made).toHaveProperty("text");
			expect(readFileSync(victim, "utf8")).toBe("the person's own\n");
			expect(replaced.isSymbolicLink(), "the link is replaced").toBe(false);
		} finally {
			rmSync(own, { recursive: true, force: true });
		}
	});

	it("hides npm's settings, pointing at nothing, where pi's folder is a link", () => {
		const own = realpathSync(mkdtempSync(join(tmpdir(), "fm-linked-")));
		const work = join(own, "work");
		const temporary = join(own, "tmp");
		mkdirSync(work);
		mkdirSync(temporary);
		mkdirSync(join(own, "elsewhere"));
		writeFileSync(
			join(own, ".npmrc"),
			"//npm.example/:_authToken=not-a-token\n",
		);
		symlinkSync(join(own, "elsewhere"), join(temporary, "pi-fence"));
		try {
			const made = fenceRunText(
				{ kind: "fence", folder: work, words: ["true"] },
				{
					env: { TMPDIR: temporary },
					home: own,
					platform: "darwin",
					sandboxExec: "/usr/bin/sandbox-exec",
				},
			);
			if (!("text" in made)) throw new Error(JSON.stringify(made));

			expect(made.text).not.toContain("NPM_CONFIG_USERCONFIG");
			expect(made.text).toContain(
				`(deny file-read* file-write* (literal "${join(own, ".npmrc")}"))`,
			);
			expect(
				existsSync(join(own, "elsewhere", "npmrc")),
				"nothing written there",
			).toBe(false);
		} finally {
			rmSync(own, { recursive: true, force: true });
		}
	});

	it("reads no ssh key, whatever kind and grants", () => {
		for (const kind of ["fence", "strict"] as const) {
			expect(
				deciding(onMac(kind), join(home, ".ssh", "id_ed25519"), "file-read*"),
				kind,
			).toMatch(/^\(deny /);
		}
	});

	it("writes only its folder when strict, so nothing it plants runs later", () => {
		const text = onMac("strict");
		for (const planted of [
			".lldbinit",
			".zsh_history",
			".local/state/mycelium/x",
		]) {
			expect(
				deciding(text, join(home, planted), "file-write*"),
				planted,
			).toMatch(/^\(deny /);
		}
		expect(deciding(text, join(folder, "out"), "file-write*")).toMatch(
			/^\(allow /,
		);
	});

	it("reads nothing of pi's or mycelium's state, so no realm's messages reach the asker", () => {
		for (const kind of ["fence", "strict"] as const) {
			for (const state of [
				".pi/agent/sessions/one/session.jsonl",
				".local/state/pi/agentic-harness.pi/mesh/messages/m.json",
				".local/state/mycelium/work.json",
			]) {
				expect(
					deciding(onMac(kind), join(home, state), "file-read*"),
					`${kind} ${state}`,
				).toMatch(/^\(deny /);
			}
		}
	});

	it("reads and writes a tree the work broker cut, though pi's state is hidden", () => {
		const trees = join(home, ".local/state/pi/agentic-harness.pi/work/trees");
		const tree = join(trees, "worktree-one");
		mkdirSync(tree, { recursive: true });
		for (const kind of ["fence", "strict"] as const) {
			const made = fenceRunText(
				{ kind, folder: tree, words: ["true"] },
				{
					env: {},
					home,
					platform: "darwin",
					sandboxExec: "/usr/bin/sandbox-exec",
					treesRoot: trees,
					heldTrees: [tree],
				},
			);
			if (!("text" in made)) throw new Error(JSON.stringify(made));
			for (const op of ["file-read*", "file-write*"] as const) {
				expect(
					deciding(made.text, join(tree, "file"), op),
					`${kind} ${op}`,
				).toMatch(/^\(allow /);
			}
			expect(
				deciding(made.text, join(home, ".local/state/pi/x"), "file-read*"),
				`${kind}: pi's state beside it`,
			).toMatch(/^\(deny /);
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
