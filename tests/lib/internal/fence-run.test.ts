/**
 * pi-fence's run (lib/internal/fence-run.ts): one command in pi's own
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
	realpathSync,
	rmSync,
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
} from "../../../lib/internal/fence-run.ts";
import { sandboxFor } from "../../../lib/internal/sandbox.ts";

describe("reading how pi-fence was asked", () => {
	it("takes the working directory when no folder is named", () => {
		expect(fenceRunAsked(["--kind", "strict", "--", "true"], "/w")).toEqual({
			kind: "strict",
			folder: "/w",
			words: ["true"],
		});
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
});

describe("the fence on a Mac", () => {
	let home: string;
	let folder: string;

	beforeAll(() => {
		home = realpathSync(mkdtempSync(join(tmpdir(), "fm-")));
		folder = join(home, "work");
		mkdirSync(join(home, ".ssh"), { recursive: true });
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

	it("writes only the folder when strict, without letting back what is hidden", () => {
		// The profile the command runs under, after the one tried on true.
		const lines = (onMac("strict").split("\nexec ")[1] ?? "").split("\n");
		const hidden = lines.indexOf(
			`(deny file-read* file-write* (subpath "${join(home, ".ssh")}"))`,
		);
		const kept = lines.lastIndexOf(`(deny file-write* (subpath "${home}"))`);

		expect(hidden, "~/.ssh is hidden").toBeGreaterThan(-1);
		expect(kept, "home is kept from writes after it").toBeGreaterThan(hidden);
		expect(lines.slice(kept + 1)).toContain(
			`(allow file-read* file-write* (subpath "${folder}"))`,
		);
		expect(
			lines
				.slice(hidden + 1)
				.some((line) =>
					line.startsWith(`(allow file-read* (subpath "${home}"))`),
				),
			"nothing lets home's reads back after the hiding",
		).toBe(false);
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
