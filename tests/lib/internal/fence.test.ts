/**
 * The agent fence: what a session asking for it is given, the arguments
 * bubblewrap and landrun are handed, the command text run through
 * stand-ins for both (so nothing here reaches the desktop), the
 * nix-offload exemption, and pi's own file tools held to it.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	FENCE,
	fenceArgs,
	fenceRules,
	NEVER_THROUGH,
	READ_ONLY,
} from "../../../lib/internal/fence.ts";
import {
	OFFLOAD_EXEMPTION_ENDS,
	offloadedOutside,
	type Sandbox,
	sandboxFor,
	wrapFor,
} from "../../../lib/internal/sandbox.ts";
import { fileToolRefusal } from "../../../lib/internal/sandbox-files.ts";

const STORE_OFFLOAD = "/nix/store/0000-nix-offload/bin/nix-offload";
const STORE_ENV = "/nix/store/0000-coreutils/bin/env";

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
			offload: { program: STORE_OFFLOAD, env: STORE_ENV },
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

	it("names both sandboxes when asked for one that isn't there", () => {
		const loose = sandboxFor({ PI_SANDBOX: "loose" }, "linux", all);
		const reason = loose.kind === "refused" ? loose.reason : "";
		expect(reason).toContain('"fence"');
		expect(reason).toContain('"strict"');
	});
});

describe("the fence's arguments", () => {
	const place = { home: "/home/someone", runtimeDir: "/run/user/1000" };
	const args = fenceArgs(place, () => true);
	const rules = fenceRules(place);

	it("gives each command its own processes and an empty runtime folder", () => {
		expect(args.join(" ")).toContain("--unshare-pid");
		expect(args.join(" ")).toContain("--proc /proc");
		expect(args.join(" ")).toContain("--die-with-parent");
		expect(args.join(" ")).toContain("--tmpfs /run/user/1000");
	});

	it("binds back only the Nix daemon's door for sandboxes", () => {
		const bound = args.flatMap((arg, at) =>
			arg === "--bind" ? [args[at + 1]] : [],
		);
		expect(bound).toEqual(["/run/user/1000/nix-untrusted.sock"]);
	});

	it("lets none of the desktop's names through, by bind or by socket", () => {
		const through = [
			...args.flatMap((arg, at) =>
				arg === "--bind" ? [args[at + 1] ?? ""] : [],
			),
			...rules.flatMap((rule, at) =>
				rule === "--unix" ? [rules[at + 1] ?? ""] : [],
			),
		];
		for (const name of NEVER_THROUGH) {
			const path = name.startsWith("/")
				? name
				: join(place.runtimeDir, name.replace(/\*$/, ""));
			const matches = (given: string) =>
				name.endsWith("*") ? given.startsWith(path) : given === path;
			expect(
				through.filter(matches),
				`${name} is let through the fence`,
			).toEqual([]);
		}
	});

	it("hides the system bus and X's sockets, and makes every startup file read-only", () => {
		expect(args.join(" ")).toContain("--tmpfs /run/dbus");
		expect(args.join(" ")).toContain("--tmpfs /tmp/.X11-unix");
		for (const path of READ_ONLY) {
			const full = join(place.home, path);
			expect(args.join(" "), `${path} is writable`).toContain(
				`--ro-bind ${full} ${full}`,
			);
		}
	});

	it("binds nothing that isn't there", () => {
		const none = fenceArgs(place, () => false);
		expect(none).not.toContain("--bind");
		expect(none).not.toContain("--ro-bind");
	});

	it("tells Landlock of only nscd's socket and the door, never every scope", () => {
		const sockets = rules.flatMap((rule, at) =>
			rule === "--unix" ? [rules[at + 1]] : [],
		);
		expect(sockets).toEqual([
			"/run/nscd/socket",
			"/run/user/1000/nix-untrusted.sock",
		]);
		expect(rules).not.toContain("--unrestricted-scoped");
		expect(rules).not.toContain("--unrestricted-filesystem");
	});
});

describe("a command in the fence, through stand-ins", () => {
	let folder: string;
	let home: string;
	let runtimeDir: string;
	let sandbox: Extract<Sandbox, { kind: "fence" }>;

	/** Runs `command` as a fenced session would, with `env` given it. */
	function run(command: string, env: Record<string, string> = {}) {
		const environment = {
			PATH: process.env.PATH ?? "",
			XDG_RUNTIME_DIR: runtimeDir,
			...env,
		};
		const wrap = wrapFor(sandbox, { cwd: folder, env: environment }, home);
		const text = wrap ? wrap(command) : command;
		return spawnSync("bash", ["-c", text], {
			cwd: folder,
			env: environment,
			encoding: "utf8",
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
		const env = spawnSync("bash", ["-c", "command -v env"], {
			encoding: "utf8",
		}).stdout.trim();
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

	it("is handed every variable but those naming the desktop, and reaches Nix by its door", () => {
		const result = run("env", {
			WAYLAND_DISPLAY: "wayland-1",
			DISPLAY: ":0",
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
			SSH_AUTH_SOCK: "/run/user/1000/ssh-tpm-agent.sock",
			NIRI_SOCKET: "/run/user/1000/niri.sock",
			NIX_REMOTE: "daemon",
			FENCE_TEST_KEPT: "kept",
		});
		const env = result.stdout;
		expect(env).toContain("FENCE_TEST_KEPT=kept");
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
		]) {
			expect(env, `${name} reached the command`).not.toMatch(
				new RegExp(`^${name}=`, "m"),
			);
		}
	});

	it("runs a nix-offload there call alone outside, with its own words and an environment of its own", () => {
		const result = run("nix-offload there -L --changed", {
			FENCE_TEST_KEPT: "kept",
			LD_PRELOAD: "/tmp/evil.so",
			BASH_ENV: "/tmp/evil.sh",
			NIX_PATH: "nixpkgs=/tmp/evil",
			USER: "someone",
		});
		expect(result.stdout).toContain("words:there -L --changed");
		const names = result.stdout
			.split("\n")
			.filter((line) => line.includes("="))
			.map((line) => line.slice(0, line.indexOf("=")));
		// bash sets PWD, SHLVL and OLDPWD for itself.
		const given = ["HOME", "LOGNAME", "PATH", "USER", "XDG_RUNTIME_DIR"];
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
			"nix-offload there; echo out",
			"nix-offload there && echo out",
			"nix-offload there | cat",
			"nix-offload there $(echo out)",
			"nix-offload there `echo out`",
			'nix-offload there "$drv^*"',
			"nix-offload there > /tmp/out",
			"nix-offload there\necho out",
			"env -u SSH_AUTH_SOCK nix-offload there",
			"nix-offload build",
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
			"the nix-offload exemption is past its day: take it out, now the SSH agent's proxy lets the fence reach the builders",
		).toBe(true);
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
		work = join(home, "src/thing");
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
		expect(refusal("write", join(work, "file.ts"))).toBeUndefined();
		expect(refusal("edit", "file.ts")).toBeUndefined();
		expect(refusal("read", join(home, ".config/thing.conf"))).toBeUndefined();
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

	it("reads no other process's files, pi's own included, and nothing in the runtime folder", () => {
		expect(refusal("read", "/proc/1/environ")).toContain("other processes");
		expect(refusal("read", "/proc/self/environ")).toContain("other processes");
		expect(refusal("read", join(runtimeDir, "clipboard-history"))).toContain(
			"runtime folder",
		);
		expect(refusal("write", join(runtimeDir, "x"))).toContain("runtime folder");
	});
});
