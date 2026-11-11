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
	type Disk,
	FENCE,
	fenceArgs,
	fenceRefusesRead,
	fenceRefusesWrite,
	fenceRules,
	HIDDEN,
	NEVER_THROUGH,
	READ_ONLY,
} from "../../../lib/internal/fence.ts";
import {
	inStore,
	OFFLOAD_EXEMPTION_ENDS,
	offloadedOutside,
} from "../../../lib/internal/offload-exemption.ts";
import {
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

/**
 * A disk where every path is a folder but the links named and any git
 * folder, and the home folder holds `entries`.
 */
function diskWith(
	home: string,
	entries: readonly string[],
	links: readonly string[] = [],
): Disk {
	return {
		kind: (path) => {
			if (links.includes(path)) return "link";
			return path.split("/").includes(".git") ? undefined : "folder";
		},
		entries: (folder) => (folder === home ? entries : []),
	};
}

describe("the fence's arguments", () => {
	const place = { home: "/home/someone", runtimeDir: "/run/user/1000" };
	const args = fenceArgs(
		place,
		diskWith(
			place.home,
			["src", ".cache", ".local", ".pi", ".config", ".bashrc", ".zshrc"],
			["/home/someone/.zshrc"],
		),
	);
	const rules = fenceRules(place);
	const pairs = (flag: string) =>
		args.flatMap((arg, at) => (arg === flag ? [args[at + 1]] : []));

	it("gives each command its own processes and an empty runtime folder", () => {
		expect(args.join(" ")).toContain("--unshare-pid");
		expect(args.join(" ")).toContain("--proc /proc");
		expect(args.join(" ")).toContain("--die-with-parent");
		expect(args.join(" ")).toContain("--tmpfs /run/user/1000");
	});

	it("binds back only the Nix daemon's door for sandboxes and the SSH agent's proxy in the runtime folder", () => {
		const bound = pairs("--bind").filter((path) =>
			path?.startsWith(place.runtimeDir),
		);
		expect(bound).toEqual([
			"/run/user/1000/nix-untrusted.sock",
			"/run/user/1000/pi-agent.sock",
		]);
	});

	it("binds the copy of the system's SSH settings over them, read-only, once it's made", () => {
		const sshConfig = "/run/user/1000/pi-fence/ssh_config";
		const given = fenceArgs(
			{ ...place, sshConfig },
			diskWith(place.home, [".config"]),
		);
		const at = given.indexOf(sshConfig);
		expect(given.slice(at - 1, at + 2)).toEqual([
			"--ro-bind",
			sshConfig,
			"/etc/ssh/ssh_config",
		]);
		expect(
			args,
			"with no copy, the system's settings are as they are",
		).not.toContain("/etc/ssh/ssh_config");
	});

	it("makes the home folder read-only, binding back writable every entry but the read-only ones and links", () => {
		expect(pairs("--ro-bind")[0]).toBe(place.home);
		const writable = pairs("--bind").filter((path) =>
			path?.startsWith(place.home),
		);
		expect(writable).toEqual([
			"/home/someone/.cache",
			"/home/someone/.local",
			"/home/someone/.pi",
			"/home/someone/src",
		]);
	});

	it("binds each deeper read-only path over its writable folder, after it", () => {
		const agent = args.lastIndexOf("/home/someone/.pi/agent");
		const pi = args.indexOf("/home/someone/.pi");
		expect(args[agent - 2], "pi's settings are writable").toBe("--ro-bind");
		expect(agent > pi, "pi's settings are bound before their folder").toBe(
			true,
		);
	});

	it("makes the folder holding a deeper read-only link read-only instead", () => {
		const linked = fenceArgs(
			place,
			diskWith(place.home, [".local"], ["/home/someone/.local/bin"]),
		);
		const readOnly = linked.flatMap((arg, at) =>
			arg === "--ro-bind" ? [linked[at + 1]] : [],
		);
		expect(readOnly).toContain("/home/someone/.local");
		expect(readOnly).not.toContain("/home/someone/.local/bin");
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

	it("hides the system bus and X's sockets, and binds no read-only path writable", () => {
		expect(args.join(" ")).toContain("--tmpfs /run/dbus");
		expect(args.join(" ")).toContain("--tmpfs /tmp/.X11-unix");
		for (const path of READ_ONLY) {
			const full = join(place.home, path);
			expect(pairs("--bind"), `${path} is writable`).not.toContain(full);
			if (path.includes("/")) {
				expect(pairs("--ro-bind"), `${path} is writable`).toContain(full);
			}
		}
	});

	it("keeps every quest's scratch folder read-only but the session's own, over the home's binds", () => {
		const scratch = {
			root: "/home/someone/.cache/pi/quest-workspace",
			own: "/home/someone/.cache/pi/quest-workspace/QEST-1",
		};
		const given = fenceArgs(
			{ ...place, scratch },
			diskWith(place.home, [".cache"]),
		);
		const root = given.lastIndexOf(scratch.root);
		const own = given.lastIndexOf(scratch.own);
		expect(given[root - 2]).toBe("--ro-bind");
		expect(given[own - 2]).toBe("--bind");
		expect(
			root > given.lastIndexOf("/home/someone/.cache"),
			"the scratch folders are bound over the cache's writable bind",
		).toBe(true);
		expect(own > root, "the session's own is bound back after").toBe(true);

		const at = { ...place, scratch };
		expect(
			fenceRefusesWrite(`${scratch.root}/QEST-2/clone/.git/config`, at),
			"another quest's scratch is read-only to pi's file tools too",
		).toBe(true);
		expect(
			fenceRefusesWrite(`${scratch.own}/tmp/x`, at),
			"the session's own scratch stays writable",
		).toBe(false);
	});

	it("binds nothing that isn't there", () => {
		const none = fenceArgs(place, { kind: () => undefined, entries: () => [] });
		const bound = none.flatMap((arg, at) =>
			arg === "--bind" || arg === "--ro-bind" ? [none[at + 1]] : [],
		);
		expect(bound, "only the root is bound").toEqual(["/"]);
	});

	it("tells Landlock of only nscd's socket and the door, never every scope", () => {
		const sockets = rules.flatMap((rule, at) =>
			rule === "--unix" ? [rules[at + 1]] : [],
		);
		expect(sockets).toEqual([
			"/run/nscd/socket",
			"/run/user/1000/nix-untrusted.sock",
			"/run/user/1000/pi-agent.sock",
		]);
		expect(rules).not.toContain("--unrestricted-scoped");
		expect(rules).not.toContain("--unrestricted-filesystem");
	});
});

/**
 * A disk holding exactly `paths`, each a file or, with a trailing `/`,
 * a folder; every folder above one is there too.
 */
function diskOf(paths: readonly string[]): Disk {
	const kinds = new Map<string, "folder" | "file">();
	for (const given of paths) {
		const folder = given.endsWith("/");
		const path = folder ? given.slice(0, -1) : given;
		kinds.set(path, folder ? "folder" : "file");
		for (let up = path; up.lastIndexOf("/") > 0; ) {
			up = up.slice(0, up.lastIndexOf("/"));
			kinds.set(up, "folder");
		}
	}
	return {
		kind: (path) => kinds.get(path),
		entries: (folder) =>
			[...kinds.keys()]
				.filter((path) => path.slice(0, path.lastIndexOf("/")) === folder)
				.map((path) => path.slice(folder.length + 1)),
	};
}

describe("what the fence keeps from the person's own keys, devices and repositories", () => {
	const home = "/home/someone";
	const tree = `${home}/trees/thing`;
	const own = `${home}/src/repo/.git/worktrees/thing`;
	const paths = [
		`${home}/.ssh/config`,
		`${home}/.ssh/known_hosts`,
		`${home}/.ssh/agent-signing.pub`,
		`${home}/.ssh/agent-signing.tpm`,
		`${home}/.ssh/id_ed25519_sk`,
		`${home}/.local/state/nix-offload/store_ed25519`,
		`${home}/.local/state/nix-offload/store_ed25519.pub`,
		`${home}/src/repo/.git/config`,
		`${home}/src/repo/.git/hooks/`,
		`${home}/src/repo/.git/info/`,
		`${home}/src/repo/.git/objects/`,
		`${home}/src/github.com/org/deep/.git/config`,
		`${home}/src/github.com/org/deep/.git/objects/`,
		`${own}/commondir`,
		`${own}/gitdir`,
		`${own}/HEAD`,
		`${home}/world/git/HEAD`,
		`${home}/world/git/config`,
		`${home}/world/git/objects/`,
		`${home}/world/git/worktrees/zone/config.worktree`,
		`${home}/world/git/worktrees/zone/index`,
		`${home}/notes/.git/config`,
		`${home}/notes/.git/hooks/`,
		`${home}/notes/.git/objects/`,
		`${tree}/.git`,
	];
	const disk = diskOf(paths);
	const args = fenceArgs(
		{ home, runtimeDir: "/run/user/1000", cwd: tree, ownGitFolder: own },
		disk,
	);
	const readOnly = args.flatMap((arg, at) =>
		arg === "--ro-bind" ? [args[at + 1]] : [],
	);

	it("gives each command a /dev of its own, so no TPM, camera, microphone or security key", () => {
		expect(args.join(" ")).toContain("--dev /dev");
		expect(args.join(" ")).toContain("--tmpfs /dev/shm");
		expect(args).not.toContain("--dev-bind");
	});

	it("empties ~/.ssh but for what names hosts and keys, and makes it read-only", () => {
		const ssh = `${home}/.ssh`;
		const at = args.indexOf(ssh);
		expect(args[at - 1]).toBe("--tmpfs");
		expect(
			readOnly.filter((path) => path?.startsWith(`${ssh}/`)).sort(),
		).toEqual([
			`${ssh}/agent-signing.pub`,
			`${ssh}/config`,
			`${ssh}/known_hosts`,
		]);
		expect(args.join(" ")).toContain(`--remount-ro ${ssh}`);
	});

	it("empties the private keys kept outside ~/.ssh, for commands and pi's file tools alike", () => {
		const key = `${home}/.local/state/nix-offload/store_ed25519`;
		expect(HIDDEN.map((path) => `${home}/${path}`)).toContain(key);
		const at = args.lastIndexOf(key);
		expect(args.slice(at - 2, at + 1), "the key is emptied inside").toEqual([
			"--ro-bind",
			"/dev/null",
			key,
		]);
		expect(args, "its public half is left as it is").not.toContain(
			`${key}.pub`,
		);
		const place = { home, runtimeDir: "/run/user/1000" };
		expect(fenceRefusesRead(key, place), "pi's read tool is refused it").toBe(
			true,
		);
		expect(
			fenceRefusesRead(`${key}.pub`, place),
			"its public half stays readable",
		).toBe(false);
	});

	it("keeps src and world read-only, each git folder there but what a commit writes", () => {
		const at = (flag: string, path: string) =>
			args.findIndex((arg, index) => arg === flag && args[index + 1] === path);
		for (const top of [`${home}/src`, `${home}/world`]) {
			expect(
				at("--ro-bind", top),
				`${top} is read-only over the home's writable bind`,
			).toBeGreaterThan(at("--bind", top));
		}
		for (const objects of [
			`${home}/src/repo/.git/objects`,
			`${home}/src/github.com/org/deep/.git/objects`,
			`${home}/world/git/objects`,
		]) {
			expect(
				at("--bind", objects),
				`${objects} is bound back writable over src's read-only bind`,
			).toBeGreaterThan(at("--ro-bind", `${home}/src`));
		}
		expect(
			args.filter((arg) => arg.startsWith(`${home}/src/repo/.git`)),
			"nothing else of a git folder in src is bound back",
		).not.toContain(`${home}/src/repo/.git/config`);
	});

	it("makes what runs code in a git folder elsewhere read-only, and leaves its objects writable", () => {
		for (const path of [
			`${home}/notes/.git/config`,
			`${home}/notes/.git/hooks`,
		]) {
			expect(readOnly, `${path} is writable`).toContain(path);
		}
		expect(readOnly, "its objects are read-only").not.toContain(
			`${home}/notes/.git/objects`,
		);
	});

	it("keeps the session's own tree pointed at its own git folder", () => {
		for (const path of [`${tree}/.git`, `${own}/commondir`, `${own}/gitdir`]) {
			expect(readOnly, `${path} is writable`).toContain(path);
		}
		const back = args.findIndex(
			(arg, at) => arg === "--bind" && args[at + 1] === own,
		);
		expect(back, "the own worktree folder isn't bound back").toBeGreaterThan(
			args.findIndex(
				(arg, at) => arg === "--ro-bind" && args[at + 1] === `${home}/src`,
			),
		);
	});

	it("binds the session's own tree in src back writable, its .git file read-only, for commands and file tools alike", () => {
		const inSrc = `${home}/src/repo/.worktrees/thing`;
		const place = {
			home,
			runtimeDir: "/run/user/1000",
			cwd: inSrc,
			ownGitFolder: own,
		};
		const withTree = diskOf([...paths, `${inSrc}/.git`]);
		const given = fenceArgs(place, withTree);
		const at = (flag: string, path: string) =>
			given.findIndex(
				(arg, index) => arg === flag && given[index + 1] === path,
			);
		expect(
			at("--bind", inSrc),
			"the tree is bound back over src's read-only bind",
		).toBeGreaterThan(at("--ro-bind", `${home}/src`));
		expect(
			at("--ro-bind", `${inSrc}/.git`),
			"its .git file stays read-only",
		).toBeGreaterThan(at("--bind", inSrc));

		const refuses = (path: string) => fenceRefusesWrite(path, place, withTree);
		expect(refuses(`${inSrc}/file.ts`), "the tree's files").toBe(false);
		expect(refuses(`${inSrc}/.git`), "the tree's .git file").toBe(true);
		expect(refuses(`${home}/src/repo/file.ts`), "the checkout").toBe(true);
		expect(refuses(`${home}/src/new/.git/config`), "a new repository").toBe(
			true,
		);
	});

	it("binds the session's own worktree folder back writable from a read-only worktrees folder, its settings still read-only", () => {
		const zone = `${home}/world/git/worktrees/zone`;
		const inWorld = fenceArgs(
			{
				home,
				runtimeDir: "/run/user/1000",
				cwd: tree,
				ownGitFolder: zone,
			},
			disk,
		);
		const at = (flag: string, path: string) =>
			inWorld.findIndex(
				(arg, index) => arg === flag && inWorld[index + 1] === path,
			);
		const worktrees = at("--ro-bind", `${home}/world`);
		const back = at("--bind", zone);
		const settings = at("--ro-bind", `${zone}/config.worktree`);
		expect(worktrees, "world is writable").toBeGreaterThan(-1);
		expect(back > worktrees, "the own folder isn't bound back").toBe(true);
		expect(settings > back, "the own settings are writable").toBe(true);
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
