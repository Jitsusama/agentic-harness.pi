/**
 * The agent fence: what a session asking for it is given, the command
 * text run through stand-ins for bubblewrap and landrun (so nothing here
 * reaches the desktop), the nix-offload exemption, and pi's own file
 * tools held to it. The arguments themselves are in fence-args.test.ts.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FENCE } from "../../../../lib/internal/fence/fence.ts";
import {
	inStore,
	OFFLOAD_EXEMPTION_ENDS,
	offloadedOutside,
} from "../../../../lib/internal/fence/offload-exemption.ts";
import {
	type Sandbox,
	sandboxFor,
	wrapFor,
} from "../../../../lib/internal/sandbox/sandbox.ts";
import { fileToolRefusal } from "../../../../lib/internal/sandbox/sandbox-files.ts";
import { quoted } from "../../../../lib/internal/sandbox/sandbox-shell.ts";

const STORE_OFFLOAD = "/nix/store/0000-nix-offload/bin/nix-offload";
const DRV = `/nix/store/${"a".repeat(32)}-check.drv`;
const STORE_ENV = "/nix/store/0000-coreutils/bin/env";

/**
 * `text` with the arguments bubblewrap reads from a file written into
 * it, as the text would carry them had there been no file.
 */
function argsReadIn(text: string): string {
	return text.replace(/--args 3 3<'([^']+)'/, (_, file: string) =>
		readFileSync(file, "utf8").split("\0").slice(0, -1).map(quoted).join(" "),
	);
}

/** A broker that never answers, so a test never asks the real one for a token. */
const noCloud = () => ({ reason: "no broker in this test" });

/** A finder that knows `programs`, as PATH would. */
function finder(programs: Record<string, string>) {
	return (program: string) => programs[program];
}

describe("what a session asking for the fence is given", () => {
	const all = finder({
		bwrap: "/bin/bwrap",
		landrun: "/bin/landrun",
		"nix-offload": STORE_OFFLOAD,
		env: STORE_ENV,
	});

	it("is the fence on Linux with bwrap and landrun, and nix-offload from the store", () => {
		expect(sandboxFor({ PI_SANDBOX: FENCE }, "linux", all)).toEqual({
			kind: "fence",
			bwrap: "/bin/bwrap",
			landrun: "/bin/landrun",
			// The broker's hour tokens, asked for only once a command runs.
			gcloud: expect.any(Function),
			// No nix-offload is there to ask, so it is taken as one from before
			// --lent-only and `outside`, which sends no commit out and is given
			// the exemption's environment from here.
			offload: {
				program: STORE_OFFLOAD,
				env: STORE_ENV,
				lentOnly: false,
				outside: false,
			},
		});
	});

	it("lets no nix-offload out that isn't the store's own", () => {
		const elsewhere = finder({
			bwrap: "/bin/bwrap",
			landrun: "/bin/landrun",
			"nix-offload": "/home/someone/bin/nix-offload",
			env: STORE_ENV,
		});
		const sandbox = sandboxFor({ PI_SANDBOX: FENCE }, "linux", elsewhere);
		expect(sandbox).toEqual({
			kind: "fence",
			bwrap: "/bin/bwrap",
			landrun: "/bin/landrun",
			gcloud: expect.any(Function),
		});
	});

	it("runs nothing without bwrap, without landrun, or off Linux, and says what is missing", () => {
		const noBwrap = sandboxFor(
			{ PI_SANDBOX: FENCE },
			"linux",
			finder({ landrun: "/bin/landrun" }),
		);
		expect(noBwrap.kind).toBe("refused");
		expect(noBwrap.kind === "refused" && noBwrap.reason).toContain("bwrap");
		expect(
			sandboxFor({ PI_SANDBOX: FENCE }, "linux", finder({ bwrap: "/b" })).kind,
		).toBe("refused");
		expect(sandboxFor({ PI_SANDBOX: FENCE }, "darwin", all).kind).toBe(
			"refused",
		);
	});

	it("carries the system's logger for its refusals, refused or not", () => {
		const logged = finder({
			bwrap: "/bin/bwrap",
			landrun: "/bin/landrun",
			logger: "/bin/logger",
		});
		const fence = sandboxFor({ PI_SANDBOX: FENCE }, "linux", logged);
		const offLinux = sandboxFor({ PI_SANDBOX: FENCE }, "darwin", logged);
		const none = sandboxFor({}, "linux", logged);
		expect(fence, "the fence's logger").toMatchObject({
			logger: "/bin/logger",
		});
		expect(offLinux, "a refusal's logger").toMatchObject({
			kind: "refused",
			logger: "/bin/logger",
		});
		expect(none, "no sandbox has nothing to log").toEqual({ kind: "none" });
	});

	it("carries the GitHub door where the system's profile holds it, and opens a plain session through it", () => {
		const withDoor = finder({
			bwrap: "/bin/bwrap",
			landrun: "/bin/landrun",
			"pi-github-door": "/bin/pi-github-door",
		});
		const fence = sandboxFor(
			{ PI_SANDBOX: FENCE },
			"linux",
			withDoor,
			undefined,
			noCloud,
		);
		expect(fence).toMatchObject({ githubDoor: "/bin/pi-github-door" });
		const home = realpathSync(mkdtempSync(join(tmpdir(), "fence-door-")));
		// Its own runtime folder, so the arguments file is always written,
		// and never into the machine's.
		const run = join(home, "run");
		mkdirSync(run);
		const text = (session: string) =>
			argsReadIn(
				wrapFor(
					fence,
					{
						cwd: home,
						env: { XDG_RUNTIME_DIR: run, PI_SESSION_ID: session },
					},
					home,
				)?.("true") ?? "",
			);
		expect(text("s-1"), "the session wasn't opened").toContain(
			"'/bin/pi-github-door' open 's-1'",
		);
		expect(text("s-1"), "its folder isn't bound").toContain(
			`'--ro-bind-try' '${run}/pi-github/sessions/s-1'`,
		);
		expect(
			text("../s"),
			"a session naming another folder was opened",
		).not.toContain("pi-github-door");
		expect(
			sandboxFor({ PI_SANDBOX: FENCE }, "linux", all),
			"a door was named where none is",
		).not.toHaveProperty("githubDoor");
		rmSync(home, { recursive: true, force: true });
	});

	it("binds the session's copy of dev's settings over the person's, and names its git file to git", () => {
		const fence = sandboxFor(
			{ PI_SANDBOX: FENCE },
			"linux",
			all,
			undefined,
			noCloud,
		);
		const base = realpathSync(mkdtempSync(join(tmpdir(), "fence-dev-")));
		const home = join(base, "home");
		const runtimeDir = join(base, "run");
		// The person's runtime folder is theirs alone, or no copies are made.
		mkdirSync(join(home, ".config", "dev"), { recursive: true });
		mkdirSync(runtimeDir, { mode: 0o700 });
		// This process's pi keeps what it made by session, so this case's
		// session is its own, whatever others in the file made.
		const session = basename(base);
		try {
			const text = argsReadIn(
				wrapFor(
					fence,
					{
						cwd: home,
						env: { XDG_RUNTIME_DIR: runtimeDir, PI_SESSION_ID: session },
					},
					home,
				)?.("true") ?? "",
			);
			const copies = join(
				runtimeDir,
				"pi-fence",
				"dev",
				`${session}.${process.pid}`,
			);
			expect(text, "dev's copy isn't bound over the person's").toContain(
				`'--bind' '${join(copies, "dev")}' '${join(home, ".config", "dev")}'`,
			);
			expect(text, "git isn't told its global file").toContain(
				`GIT_CONFIG_GLOBAL=${join(copies, "git", "config")}`,
			);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("fences one asking for a sandbox that isn't there, naming it", () => {
		const loose = sandboxFor({ PI_SANDBOX: "loose" }, "linux", all);
		expect(loose.kind, "an unknown name wasn't fenced").toBe("fence");
		const note = loose.kind === "fence" ? loose.note : "";
		expect(note, "the note doesn't name what was asked").toContain(
			'PI_SANDBOX="loose"',
		);
	});

	it("says nothing of a fence asked for by name", () => {
		const asked = sandboxFor({ PI_SANDBOX: FENCE }, "linux", all);
		expect(asked, "a fence asked for gained a note").not.toHaveProperty("note");
	});
});

describe("a command in the fence, through stand-ins", () => {
	let folder: string;
	let home: string;
	let runtimeDir: string;
	let sandbox: Extract<Sandbox, { kind: "fence" }>;

	/** Runs `command` as a fenced session would, with `env` given it. */
	function run(
		command: string,
		env: Record<string, string> = {},
		fence: Extract<Sandbox, { kind: "fence" }> = sandbox,
	) {
		const environment = {
			PATH: process.env.PATH ?? "",
			XDG_RUNTIME_DIR: runtimeDir,
			...env,
		};
		const wrap = wrapFor(fence, { cwd: folder, env: environment }, home);
		const text = wrap ? wrap(command) : command;
		// No stdin, as pi's bash tool starts a command: bash takes a socket
		// on stdin for sshd and reads /etc/bashrc, which on NixOS sets PATH
		// afresh, so the path a command keeps couldn't be seen.
		return spawnSync("bash", ["-c", text], {
			cwd: folder,
			env: environment,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	beforeAll(() => {
		folder = realpathSync(mkdtempSync(join(tmpdir(), "fence-")));
		home = join(folder, "home");
		runtimeDir = join(folder, "run");
		mkdirSync(home);
		mkdirSync(runtimeDir);
		// Skips its own arguments and runs what follows the first `--`.
		const bwrap = join(folder, "bwrap");
		writeFileSync(
			bwrap,
			[
				"#!/usr/bin/env bash",
				'while [ "$1" != -- ]; do shift; done',
				"shift",
				'exec "$@"',
			].join("\n"),
		);
		// Keeps only the variables named with --env, as landrun does, and
		// runs what follows `--`.
		const landrun = join(folder, "landrun");
		writeFileSync(
			landrun,
			[
				"#!/usr/bin/env bash",
				"kept=()",
				'while [ "$1" != -- ]; do',
				"  case $1 in",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
				'    --env) case $2 in *=*) kept+=("$2");; *) [ -n "${!2+set}" ] && kept+=("$2=${!2}");; esac; shift 2;;',
				"    --unrestricted-network|--ignore-missing) shift;;",
				"    *) shift 2;;",
				"  esac",
				"done",
				"shift",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
				'exec env -i "${kept[@]}" "$@"',
			].join("\n"),
		);
		// Says the words and the environment it was started with, through
		// bash's own builtins, since its PATH holds only the system's.
		const bash = spawnSync("bash", ["-c", "command -v bash"], {
			encoding: "utf8",
		}).stdout.trim();
		const offload = join(folder, "nix-offload");
		writeFileSync(
			offload,
			[
				`#!${bash}`,
				'echo "words:$*"',
				// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
				'for name in $(compgen -e); do echo "$name=${!name}"; done',
			].join("\n"),
		);
		for (const program of [bwrap, landrun, offload]) chmodSync(program, 0o755);
		// Through its links, as a session finds it: on NixOS, coreutils'
		// one binary for every program, which acts by the name it is given.
		const env = realpathSync(
			spawnSync("bash", ["-c", "command -v env"], {
				encoding: "utf8",
			}).stdout.trim(),
		);
		sandbox = {
			kind: "fence",
			bwrap,
			landrun,
			offload: { program: offload, env },
		};
	});

	afterAll(() => rmSync(folder, { recursive: true, force: true }));

	it("runs with its output and its exit as they were", () => {
		const result = run("echo inside; exit 7");
		expect(result.stdout).toContain("inside");
		expect(result.status).toBe(7);
	});

	it("tells a command naming secret-asks of secret_run, and still runs it", () => {
		const result = run("echo secret-asks named; exit 3");
		expect(result.stderr, "no word of secret_run").toContain("secret_run");
		expect(result.stdout, "the command didn't run").toContain("named");
		expect(result.status, "its exit was lost").toBe(3);
		expect(run("echo plain").stderr, "a plain command was noted").not.toContain(
			"secret_run",
		);
	});

	it("is handed the agents' cloud token and project, its settings in the fence's own place", () => {
		const token = "ya29.agents-only";
		const result = run(
			'echo "$CLOUDSDK_AUTH_ACCESS_TOKEN $CLOUDSDK_CORE_PROJECT $CLOUDSDK_CONFIG"',
			{ PI_SESSION_ID: "s-cloud" },
			{ ...sandbox, gcloud: () => ({ token, project: "a-lab-project" }) },
		);
		const [given, project, settings] = result.stdout.trim().split(" ");
		expect(given, "the token wasn't handed in").toBe(token);
		expect(project, "the project wasn't handed in").toBe("a-lab-project");
		expect(settings, "gcloud's settings aren't the fence's").toMatch(
			new RegExp(`^${join(home, ".cache/pi-fence/gcloud")}/`),
		);
	});

	it("is handed every variable but those naming the desktop, and reaches Nix by its door", () => {
		const result = run("env", {
			WAYLAND_DISPLAY: "wayland-1",
			DISPLAY: ":0",
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
			SSH_AUTH_SOCK: "/run/user/1000/ssh-tpm-agent.sock",
			NIRI_SOCKET: "/run/user/1000/niri.sock",
			NIX_REMOTE: "daemon",
			NODE_COMPILE_CACHE: join(
				home,
				".local/state/pi/agentic-harness.pi/node-compile-cache",
			),
			CARGO_HOME: join(home, ".cargo"),
			FENCE_TEST_KEPT: "kept",
		});
		const env = result.stdout;
		expect(env).toContain("FENCE_TEST_KEPT=kept");
		for (const [name, tool] of [
			["CARGO_HOME", "cargo"],
			["GRADLE_USER_HOME", "gradle"],
		]) {
			expect(env, `${name} is the fence's own`).toMatch(
				new RegExp(
					`^${name}=${join(home, ".cache/pi-fence/homes", tool ?? "")}$`,
					"m",
				),
			);
		}
		expect(env).toContain(
			`NIX_REMOTE=unix://${join(runtimeDir, "nix-untrusted.sock")}`,
		);
		for (const name of [
			"WAYLAND_DISPLAY",
			"DISPLAY",
			"DBUS_SESSION_BUS_ADDRESS",
			"SSH_AUTH_SOCK",
			"NIRI_SOCKET",
			"PI_SANDBOXED_COMMAND",
			// Read-only inside: node there uses the temporary folder's.
			"NODE_COMPILE_CACHE",
		]) {
			expect(env, `${name} reached the command`).not.toMatch(
				new RegExp(`^${name}=`, "m"),
			);
		}
	});

	it("reaches an SSH agent only through the proxy, once the proxy is there", () => {
		const proxy = join(runtimeDir, "pi-agent.sock");
		writeFileSync(proxy, "");
		try {
			const result = run("env", {
				SSH_AUTH_SOCK: "/run/user/1000/ssh-tpm-agent.sock",
			});
			const given = result.stdout
				.split("\n")
				.filter((line) => line.startsWith("SSH_AUTH_SOCK="));
			expect(given).toEqual([`SSH_AUTH_SOCK=${proxy}`]);
		} finally {
			rmSync(proxy);
		}
	});

	it("copies through the fence's own wl-copy, once it's there, and names no display at all", () => {
		const shims = join(home, ".local", "share", "pi-fence", "bin");
		mkdirSync(shims, { recursive: true });
		writeFileSync(join(shims, "wl-copy"), '#!/bin/sh\necho "the fence\'s"\n');
		chmodSync(join(shims, "wl-copy"), 0o755);
		try {
			const result = run(
				'echo "display=$WAYLAND_DISPLAY"; echo "path=$PATH"; wl-copy',
				{ WAYLAND_DISPLAY: "wayland-1", NIRI_SOCKET: "/run/niri.sock" },
			);
			expect(result.stdout, "a display reached the command").toContain(
				"display=\n",
			);
			expect(
				result.stdout,
				"the shims come first, then the path as it was",
			).toContain(`path=${shims}:${process.env.PATH ?? ""}\n`);
			expect(result.stdout, "the fence's wl-copy ran").toContain(
				"the fence's\n",
			);
			expect(result.stdout, "niri's ipc reached the command").not.toContain(
				"niri.sock",
			);
		} finally {
			rmSync(join(home, ".local", "share", "pi-fence"), { recursive: true });
		}
	});

	it("names only the sandboxed display, once it's there", () => {
		const folder = join(runtimeDir, "pi-fence-display");
		mkdirSync(folder, { recursive: true });
		const display = join(folder, "wayland");
		writeFileSync(display, "");
		try {
			const result = run(
				'echo "display=$WAYLAND_DISPLAY"; echo "niri=$NIRI_SOCKET"',
				{ WAYLAND_DISPLAY: "wayland-1", NIRI_SOCKET: "/run/niri.sock" },
			);
			expect(
				result.stdout,
				"the person's display, or none, was named",
			).toContain(`display=${display}\n`);
			expect(result.stdout, "niri's ipc reached the command").toContain(
				"niri=\n",
			);
		} finally {
			rmSync(folder, { recursive: true });
		}
	});

	it("runs a nix-offload there call alone outside, with its own words and an environment of its own", () => {
		const result = run(`nix-offload there -L ${DRV}^*`, {
			FENCE_TEST_KEPT: "kept",
			LD_PRELOAD: "/tmp/evil.so",
			BASH_ENV: "/tmp/evil.sh",
			NIX_PATH: "nixpkgs=/tmp/evil",
			USER: "someone",
		});
		expect(result.stdout).toContain(`words:there -L ${DRV}^*`);
		const names = result.stdout
			.split("\n")
			.filter((line) => line.includes("="))
			.map((line) => line.slice(0, line.indexOf("=")));
		// bash sets PWD, SHLVL and OLDPWD for itself.
		// The GIT_ ones hold its git away from any .git (offload-exemption).
		const given = [
			"GIT_CEILING_DIRECTORIES",
			"GIT_CONFIG_COUNT",
			"GIT_CONFIG_KEY_0",
			"GIT_CONFIG_VALUE_0",
			"GIT_DIR",
			"HOME",
			"LOGNAME",
			"PATH",
			"USER",
			"XDG_RUNTIME_DIR",
		];
		const own = ["OLDPWD", "PWD", "SHLVL", "_"];
		expect(
			names.filter((name) => !own.includes(name)).sort(),
			"the exemption handed on more than its own environment",
		).toEqual(given);
		expect(result.stdout).toContain(
			"PATH=/etc/profiles/per-user/someone/bin:/run/current-system/sw/bin",
		);
	});

	it("keeps fenced any nix-offload call with anything chained, quoted or expanded", () => {
		for (const command of [
			`nix-offload there ${DRV}; echo out`,
			`nix-offload there ${DRV} && echo out`,
			`nix-offload there ${DRV} | cat`,
			`nix-offload there ${DRV} $(echo out)`,
			`nix-offload there ${DRV} \`echo out\``,
			'nix-offload there "$drv^*"',
			`nix-offload there ${DRV} > /tmp/out`,
			`nix-offload there ${DRV}\necho out`,
			`env -u SSH_AUTH_SOCK nix-offload there ${DRV}`,
			`nix-offload build ${DRV}`,
		]) {
			expect(
				offloadedOutside(command, sandbox.offload, { home, env: {} }),
				command,
			).toBeUndefined();
		}
	});

	it("is let out only until the fence reaches the builders itself", () => {
		expect(
			new Date() < new Date(`${OFFLOAD_EXEMPTION_ENDS}T00:00:00-05:00`),
			"the nix-offload exemption is past its day: take it out, now a broker holds the builders' key",
		).toBe(true);
	});

	it("counts a program as the store's only where its path, resolved, lies in the store", () => {
		expect(inStore("/nix/store/0000-gone/bin/nix-offload")).toBe(
			"/nix/store/0000-gone/bin/nix-offload",
		);
		expect(
			inStore("/nix/store/../home/someone/bin/nix-offload"),
			"a missing path climbing out of the store by name counts as the store's",
		).toBeUndefined();
		expect(inStore("/home/someone/bin/nix-offload")).toBeUndefined();
	});
});

describe("pi's file tools in a fenced session", () => {
	let base: string;
	let home: string;
	let work: string;
	let runtimeDir: string;

	beforeAll(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "fence-files-")));
		home = join(base, "home");
		work = join(home, "work/thing");
		runtimeDir = join(base, "run");
		for (const folder of [work, join(home, ".config"), runtimeDir]) {
			mkdirSync(folder, { recursive: true });
		}
	});

	afterAll(() => rmSync(base, { recursive: true, force: true }));

	const refusal = (toolName: string, path: string) =>
		fileToolRefusal(
			{ toolName, input: { path, content: "" } },
			{
				cwd: work,
				home,
				env: { PI_SANDBOX: FENCE, XDG_RUNTIME_DIR: runtimeDir },
			},
		);

	it("writes and reads the work, and reads the settings", () => {
		writeFileSync(join(home, ".history"), "");
		expect(refusal("write", join(home, ".history"))).toBeUndefined();
		expect(refusal("write", join(work, "file.ts"))).toBeUndefined();
		expect(refusal("edit", "file.ts")).toBeUndefined();
		expect(refusal("read", join(home, ".config/thing.conf"))).toBeUndefined();
	});

	it("writes nothing in a checkout under src that isn't the session's own tree", () => {
		const checkout = join(home, "src/repo");
		mkdirSync(checkout, { recursive: true });
		expect(refusal("write", join(checkout, "file.ts"))).toContain(
			"under ~/src and ~/world",
		);
		expect(refusal("read", join(checkout, "file.ts"))).toBeUndefined();
	});

	it("writes no settings or startup file, even through a link", () => {
		expect(refusal("write", join(home, ".config/autostart.sh"))).toContain(
			"read-only",
		);
		expect(refusal("edit", "~/.bashrc")).toContain("read-only");
		const link = join(work, "sneaky");
		spawnSync("ln", ["-s", join(home, ".config"), link]);
		expect(refusal("write", join(link, "x"))).toContain("read-only");
	});

	it("writes nothing in a folder the person browses but the one the session works in", () => {
		mkdirSync(join(home, "Downloads"), { recursive: true });
		expect(refusal("write", join(home, "Downloads/x/.git/config"))).toContain(
			"folders the person browses",
		);
		expect(refusal("write", join(home, "work/other.ts"))).toBeUndefined();
	});

	it("makes the folders it keeps within an entry first, since a command could make none", () => {
		for (const entry of [".bundle", ".local"]) {
			mkdirSync(join(home, entry), { recursive: true });
		}
		wrapFor(
			{ kind: "fence", bwrap: "bwrap", landrun: "landrun" },
			{ cwd: work, env: { XDG_RUNTIME_DIR: runtimeDir } },
			home,
		);
		expect(existsSync(join(home, ".bundle/cache")), "bundler's own cache").toBe(
			true,
		);
		for (const folder of [".local/share/dbus-1", ".local/bin"]) {
			expect(
				existsSync(join(home, folder)),
				`${folder}, so it can be bound read-only`,
			).toBe(true);
		}
		expect(existsSync(join(home, ".kube")), "no entry that wasn't").toBe(false);
		expect(existsSync(join(home, ".pi")), "nor one under it").toBe(false);
	});

	it("makes no file in the home folder itself, and writes no link there", () => {
		expect(refusal("write", join(home, ".newrc"))).toContain("read-only");
		spawnSync("ln", ["-s", join(work, "file.ts"), join(home, ".linked")]);
		expect(refusal("write", join(home, ".linked"))).toContain("read-only");
	});

	it("reads no other process's files, pi's own included, and nothing in the runtime folder", () => {
		expect(refusal("read", "/proc/1/environ")).toContain("other processes");
		expect(refusal("read", "/proc/self/environ")).toContain("other processes");
		expect(refusal("read", join(runtimeDir, "clipboard-history"))).toContain(
			"runtime folder",
		);
		expect(refusal("write", join(runtimeDir, "x"))).toContain("runtime folder");
	});
});
