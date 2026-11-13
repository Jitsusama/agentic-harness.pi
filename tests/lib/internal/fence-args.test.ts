/**
 * The arguments bubblewrap and landrun are handed for the agent fence,
 * read from fake disks, and what they keep from the person's own keys,
 * devices and repositories.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type Disk,
	fenceArgs,
	fenceRefusesRead,
	fenceRefusesWrite,
	fenceRules,
	HIDDEN,
	jobsBroker,
	NEVER_THROUGH,
} from "../../../lib/internal/fence.ts";
import { READ_ONLY } from "../../../lib/internal/fence-home.ts";

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

	it("binds back only the Nix daemon's door for sandboxes, the SSH agent's proxy and the jobs broker in the runtime folder", () => {
		const bound = pairs("--bind").filter((path) =>
			path?.startsWith(place.runtimeDir),
		);
		expect(bound).toEqual([
			"/run/user/1000/nix-untrusted.sock",
			"/run/user/1000/pi-agent.sock",
			"/run/user/1000/daemons/jobs-broker.sock",
		]);
	});

	it("names the jobs broker's socket only where the machine runs it", () => {
		const socket = "/run/user/1000/daemons/jobs-broker.sock";
		const only = (path: string): Disk => ({
			kind: (given) => (given === path ? "file" : undefined),
			entries: () => [],
		});
		expect(
			[
				jobsBroker(place.runtimeDir, only(socket)),
				jobsBroker(place.runtimeDir, only("/elsewhere")),
				jobsBroker(undefined, only(socket)),
			],
			"there, not there, no runtime folder",
		).toEqual([socket, undefined, undefined]);
	});

	it("makes the cgroup tree read-only, so a command moves no process and sets no limit", () => {
		const at = args.lastIndexOf("/sys/fs/cgroup");
		expect(args.slice(at - 2, at + 1), "bound read-only over itself").toEqual([
			"--ro-bind",
			"/sys/fs/cgroup",
			"/sys/fs/cgroup",
		]);
		expect(pairs("--bind"), "never writable").not.toContain("/sys/fs/cgroup");
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

	it("binds the copy over the file the system's settings link to, since bubblewrap won't mount on a link", () => {
		// NixOS links /etc/ssh/ssh_config into the store, and every fenced
		// command failed on 11 November until the bind went past the link.
		const sshConfig = "/run/user/1000/pi-fence/ssh_config";
		const stored = "/nix/store/0000-etc-ssh-ssh_config";
		const disk = {
			...diskWith(place.home, [".config"], ["/etc/ssh/ssh_config"]),
			real: (path: string) =>
				path === "/etc/ssh/ssh_config" ? stored : undefined,
		};
		const given = fenceArgs({ ...place, sshConfig }, disk);
		const at = given.indexOf(sshConfig);

		expect(given.slice(at - 1, at + 2), "the copy's bind").toEqual([
			"--ro-bind",
			sshConfig,
			stored,
		]);
		expect(given, "nothing mounts on the link itself").not.toContain(
			"/etc/ssh/ssh_config",
		);
	});

	it("makes the home folder read-only, binding back writable every hidden entry but the read-only ones and links", () => {
		expect(pairs("--ro-bind")[0]).toBe(place.home);
		const writable = pairs("--bind").filter((path) =>
			path?.startsWith(place.home),
		);
		expect(writable).toEqual([
			"/home/someone/.cache",
			"/home/someone/.local",
			"/home/someone/.pi",
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

	it("tells Landlock of only nscd's socket and the doors, never every scope", () => {
		const sockets = rules.flatMap((rule, at) =>
			rule === "--unix" ? [rules[at + 1]] : [],
		);
		expect(sockets).toEqual([
			"/run/nscd/socket",
			"/run/user/1000/nix-untrusted.sock",
			"/run/user/1000/pi-agent.sock",
			"/run/user/1000/daemons/jobs-broker.sock",
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

describe("the folders the person browses in the home folder", () => {
	// A command could make ~/Downloads/x/.git with a clean filter in its
	// settings, which git status runs when the person's prompt enters it.
	const home = "/home/someone";
	const disk = diskWith(home, [
		".cache",
		".npm",
		"Documents",
		"Downloads",
		"demo",
		"notes.txt",
		"src",
	]);
	const writable = (cwd: string) => {
		const args = fenceArgs({ home, runtimeDir: undefined, cwd }, disk);
		return args.flatMap((arg, at) =>
			arg === "--bind" && args[at + 1]?.startsWith(home) ? [args[at + 1]] : [],
		);
	};

	it("keeps each one read-only, so no command plants a repository there for the person's git to run", () => {
		expect(
			writable(`${home}/.local/state/trees/thing`),
			"only the hidden entries are bound back",
		).toEqual([`${home}/.cache`, `${home}/.npm`]);
		expect(writable(home), "nor for a session in the home folder").toEqual([
			`${home}/.cache`,
			`${home}/.npm`,
		]);
	});

	it("binds back writable the one the session works in, but never src or world whole", () => {
		expect(writable(`${home}/demo/play`), "the session's own").toEqual([
			`${home}/.cache`,
			`${home}/.npm`,
			`${home}/demo`,
		]);
		expect(writable(`${home}/src/repo`), "a checkout in src").toEqual([
			`${home}/.cache`,
			`${home}/.npm`,
		]);
	});

	it("refuses pi's file tools there too", () => {
		const place = { home, runtimeDir: undefined, cwd: `${home}/demo/play` };
		const refuses = (path: string) => fenceRefusesWrite(path, place, disk);
		expect(
			refuses(`${home}/Downloads/x/.git/config`),
			"a repository in Downloads",
		).toBe(true);
		expect(refuses(`${home}/Documents/file.txt`), "a document").toBe(true);
		expect(refuses(`${home}/notes.txt`), "a file atop the home folder").toBe(
			true,
		);
		expect(refuses(`${home}/demo/runbook.md`), "the session's own").toBe(false);
		expect(refuses(`${home}/.cache/thing`), "a cache").toBe(false);
	});
});

describe("programs' hidden entries that run code as the person later", () => {
	// Each is read as the person outside the fence: zsh sources its
	// completion dump, dbus starts a service named there, nvim loads its
	// site plugins, Chrome trusts a CA added there, kubectl and aws run a
	// credential command their settings name, cargo builds the sources it
	// extracted, and gpg, gradle and docker run what theirs name. A
	// rustup proxy runs its toolchains' binaries, Firefox runs the program
	// a native messaging host names, and bundler loads its settings and
	// plugins.
	const home = "/home/someone";
	const disk = diskOf([
		`${home}/.zcompdump-optimus-5.9.2`,
		`${home}/.zcompdump-optimus-5.9.2.zwc`,
		`${home}/.kube/cache/`,
		`${home}/.kube/gke_gcloud_auth_plugin_cache`,
		`${home}/.aws/sso/cache/`,
		`${home}/.cargo/registry/`,
		`${home}/.gnupg/`,
		`${home}/.pki/nssdb/`,
		`${home}/.gradle/init.d/`,
		`${home}/.docker/`,
		`${home}/.local/share/dbus-1/services/`,
		`${home}/.local/share/nvim/site/`,
		`${home}/.rustup/toolchains/`,
		`${home}/.mozilla/native-messaging-hosts/`,
		`${home}/.bundle/cache/`,
		`${home}/.cache/`,
		`${home}/.npm/`,
	]);
	const place = { home, runtimeDir: undefined, cwd: `${home}/.cache/work` };
	const args = fenceArgs(place, disk);
	const pairs = (flag: string) =>
		args.flatMap((arg, at) => (arg === flag ? [args[at + 1]] : []));

	it("binds back writable only the caches among them", () => {
		expect(
			pairs("--bind").filter((path) => path?.startsWith(home)),
			"the writable entries and the caches within the read-only ones",
		).toEqual([
			`${home}/.cache`,
			`${home}/.local`,
			`${home}/.npm`,
			`${home}/.kube/cache`,
			`${home}/.kube/gke_gcloud_auth_plugin_cache`,
			`${home}/.aws/sso/cache`,
			`${home}/.bundle/cache`,
		]);
		expect(pairs("--ro-bind"), "dbus's services and nvim's plugins").toEqual(
			expect.arrayContaining([
				`${home}/.local/share/dbus-1`,
				`${home}/.local/share/nvim`,
			]),
		);
	});

	it("refuses pi's file tools the same, an entry not yet there included", () => {
		const refuses = (path: string) =>
			fenceRefusesWrite(`${home}/${path}`, place, disk);
		for (const path of [
			".zcompdump-optimus-5.9.2",
			".zcompdump-optimus-5.9.2.zwc",
			".kube/config",
			".aws/credentials",
			".cargo/config.toml",
			".cargo/registry/src/index/crate/build.rs",
			".gnupg/gpg-agent.conf",
			".pki/nssdb/cert9.db",
			".gradle/init.d/thing.gradle",
			".docker/cli-plugins/docker-thing",
			".local/share/dbus-1/services/thing.service",
			".local/share/nvim/site/plugin/thing.lua",
			".rustup/toolchains/stable/bin/cargo",
			".mozilla/native-messaging-hosts/thing.json",
			".bundle/config",
			".bundle/plugin/index",
		]) {
			expect(refuses(path), `${path} was writable`).toBe(true);
		}
		for (const path of [
			".kube/cache/discovery",
			".aws/sso/cache/token.json",
			".aws/cli/cache/role.json",
			".npm/_cacache/index",
			".bundle/cache/compact_index/thing",
		]) {
			expect(refuses(path), `${path} was refused`).toBe(false);
		}
	});
});

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
