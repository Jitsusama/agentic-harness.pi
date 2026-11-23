/**
 * The arguments bubblewrap and landrun are handed for the agent fence,
 * read from fake disks, and what they keep from the person's own keys,
 * devices and repositories. Long because every case reads the fence's one
 * policy off the same fake disks, so its parts change together.
 */

import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
	fenceArgs,
	fenceRefusesRead,
	fenceRefusesWrite,
	fenceRules,
	HIDDEN,
	jobsBroker,
	NEVER_THROUGH,
} from "../../../../lib/internal/fence/fence.ts";
import type { Disk } from "../../../../lib/internal/fence/fence-disk.ts";
import { githubDoorFolder } from "../../../../lib/internal/fence/fence-github.ts";
import {
	foldersMadeFirst,
	READ_ONLY,
} from "../../../../lib/internal/fence/fence-home.ts";
import { mountsOf } from "../../../../lib/internal/fence/fence-pins.ts";
import { plantedCache } from "../../../../lib/internal/fence/fence-temp-caches.ts";

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

/** Whether `path` is `folder` or lies in it, however either is spelled. */
function within(path: string, folder: string): boolean {
	const at = relative(folder, path);
	return at === "" || (!at.startsWith("..") && !isAbsolute(at));
}

/**
 * Whether `given` reaches the never-through `name`, at `path` outside:
 * it is the name, a folder above it or something in it, or, for a name
 * ending in a wildcard, a match or something in one.
 */
function reaches(given: string, name: string, path: string): boolean {
	if (!name.endsWith("*")) return within(path, given) || within(given, path);
	const folder = dirname(path);
	if (within(folder, given)) return true;
	const [first] = relative(folder, given).split(sep);
	return (
		within(given, folder) &&
		(first ?? "").startsWith(basename(path).slice(0, -1))
	);
}

/**
 * Each name the fence must keep out that its Landlock rules or its
 * mounts reach. A rule reaches a name by naming it or a folder above it.
 * A mount reaches one whose host path its source holds, wherever that
 * lands, unless it lands in the runtime folder before the tmpfs laid
 * over it, as the whole disk's bind does; a mount laid after that tmpfs
 * at or above the folder uncovers it. Every option bubblewrap is given
 * is read as the fence reads it (`mountsOf`), an overlay by each of its
 * sources. An absolute name is seen where it is through the whole disk's
 * bind, so only the rules keep it shut there; a mount carrying it
 * anywhere else could put it under a rule, so that reaches it.
 */
function namesReached(
	args: readonly string[],
	rules: readonly string[],
	runtimeDir: string,
): string[] {
	const ruled = rules.flatMap((rule, at) =>
		rule === "--unix" ? [rules[at + 1] ?? ""] : [],
	);
	const mounts = mountsOf(args);
	const emptied = Math.max(
		...mounts
			.filter((mount) => mount.option === "--tmpfs" && mount.to === runtimeDir)
			.map((mount) => mount.at),
	);
	return NEVER_THROUGH.filter((name) => {
		const path = isAbsolute(name) ? name : join(runtimeDir, name);
		if (ruled.some((given) => reaches(given, name, path))) return true;
		return mounts.some((mount) =>
			shownBy(args, mount).some((from) => {
				if (!mount.to || !reaches(from, name, path)) return false;
				const lands = within(path, from)
					? join(mount.to, relative(from, path))
					: mount.to;
				if (isAbsolute(name)) return lands !== path;
				return !(mount.at < emptied && within(lands, runtimeDir));
			}),
		);
	});
}

/**
 * What `mount` shows where it lands: a bind's source, or each of an
 * overlay's sources, which come just before it, and, since an overlay
 * may write through to where it lands, that place too.
 */
function shownBy(
	args: readonly string[],
	mount: ReturnType<typeof mountsOf>[number],
): string[] {
	if (mount.option !== "--tmp-overlay") return mount.from ? [mount.from] : [];
	const sources: string[] = [];
	for (let at = mount.at; args[at] === "--overlay-src"; at += 2) {
		sources.push(args[at + 1] ?? "");
	}
	return mount.to ? [...sources, mount.to] : sources;
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

	it("empties the login's compile caches even where no runtime folder is fenced, as from ssh", () => {
		const roots = ["/run/user/1000/pi-compile"];
		const everything: Disk = { kind: () => "folder", entries: () => [] };
		const tmpfsOf = (given: string[]) =>
			given.flatMap((arg, at) => (arg === "--tmpfs" ? [given[at + 1]] : []));
		const unfenced = fenceArgs(
			{ home: place.home, runtimeDir: undefined, compileRoots: roots },
			everything,
		);
		expect(tmpfsOf(unfenced), "a tmpfs of its own over them").toContain(
			"/run/user/1000/pi-compile",
		);
		expect(
			tmpfsOf(fenceArgs({ ...place, compileRoots: roots }, everything)).filter(
				(path) => path?.startsWith("/run/user/1000/"),
			),
			"none more where the runtime folder is emptied already",
		).toEqual([]);
		const noLogin: Disk = {
			kind: (path) => (path.startsWith("/run/user") ? undefined : "folder"),
			entries: () => [],
		};
		expect(
			tmpfsOf(
				fenceArgs(
					{ home: place.home, runtimeDir: undefined, compileRoots: roots },
					noLogin,
				),
			).filter((path) => path?.startsWith("/run") && path !== "/run/dbus"),
			"none, nor over a folder above, where no runtime folder can be made",
		).toEqual([]);
	});

	it("hides where the login's runtime folder would be made, when it has none yet, so one made later is out of reach", () => {
		const roots = ["/run/user/1000/pi-compile"];
		const beforeLogin: Disk = {
			kind: (path) => (path.startsWith("/run/user/") ? undefined : "folder"),
			entries: () => [],
		};
		const args = fenceArgs(
			{ home: place.home, runtimeDir: undefined, compileRoots: roots },
			beforeLogin,
		);
		expect(args.join(" ")).toContain("--tmpfs /run/user ");
	});

	it("hides the folder two missing runtime folders would be made in once, not once a root", () => {
		const roots = ["/run/user/1000/pi-compile", "/run/user/1001/pi-compile"];
		const beforeLogin: Disk = {
			kind: (path) => (path.startsWith("/run/user/") ? undefined : "folder"),
			entries: () => [],
		};
		const args = fenceArgs(
			{ home: place.home, runtimeDir: undefined, compileRoots: roots },
			beforeLogin,
		);
		expect(
			args.filter(
				(arg, at) => arg === "/run/user" && args[at - 1] === "--tmpfs",
			),
		).toHaveLength(1);
	});

	it("hides nothing above a missing runtime folder that holds the fence's own, or that is no plain folder", () => {
		const roots = ["/run/user/1000/pi-compile"];
		const tmpfsOf = (given: string[]) =>
			given.flatMap((arg, at) => (arg === "--tmpfs" ? [given[at + 1]] : []));
		const missing = (above: "folder" | "link"): Disk => ({
			kind: (path) =>
				path === "/run/user/1000" || path.startsWith("/run/user/1000/")
					? undefined
					: path === "/run/user"
						? above
						: "folder",
			entries: () => [],
		});
		expect(
			tmpfsOf(
				fenceArgs(
					{
						home: place.home,
						runtimeDir: "/run/user/2000",
						compileRoots: roots,
					},
					missing("folder"),
				),
			),
			"the fence's own runtime folder kept in reach",
		).not.toContain("/run/user");
		expect(
			tmpfsOf(
				fenceArgs(
					{ home: place.home, runtimeDir: undefined, compileRoots: roots },
					missing("link"),
				),
			),
			"nothing mounted over a link",
		).not.toContain("/run/user");
	});

	it("keeps read-only the runtime folder holding a compile root that is no folder, so nothing inside swaps it for a folder a host trusts", () => {
		const roots = ["/run/user/1000/pi-compile"];
		for (const kind of ["file", "link"] as const) {
			const planted: Disk = {
				kind: (path) => (path === roots[0] ? kind : "folder"),
				entries: () => [],
			};
			const given = fenceArgs(
				{ home: place.home, runtimeDir: undefined, compileRoots: roots },
				planted,
			).join(" ");
			expect(
				given,
				`nothing over a ${kind} left there, which bubblewrap can't mount over`,
			).not.toContain("--tmpfs /run/user/1000/pi-compile");
			expect(
				given,
				`the folder a ${kind} is left in kept read-only, its sockets still reached`,
			).toContain("--ro-bind /run/user/1000 /run/user/1000");
			const inside = fenceArgs(
				{
					home: place.home,
					runtimeDir: "/run/user/1000/own",
					compileRoots: roots,
				},
				planted,
			).join(" ");
			expect(
				inside.indexOf("--ro-bind /run/user/1000 "),
				"kept read-only before the fence's own runtime folder goes over it",
			).toBeLessThan(inside.indexOf("--tmpfs /run/user/1000/own"));
			expect(inside.indexOf("--ro-bind /run/user/1000 ")).toBeGreaterThan(0);
		}
	});

	it("binds back only the Nix daemon's door for sandboxes, the SSH agent's proxy, its folder, the jobs broker, the clipboard door's folder and the sandboxed display's in the runtime folder, each read-only", () => {
		expect(
			pairs("--bind").filter((path) => path?.startsWith(place.runtimeDir)),
			"something in the runtime folder is bound writable",
		).toEqual([]);
		const bound = pairs("--ro-bind").filter((path) =>
			path?.startsWith(place.runtimeDir),
		);
		expect(bound).toEqual([
			"/run/user/1000/nix-untrusted.sock",
			"/run/user/1000/pi-agent.sock",
			"/run/user/1000/pi-agent",
			"/run/user/1000/daemons/jobs-broker.sock",
			"/run/user/1000/pi-clipboard",
			"/run/user/1000/pi-fence-display",
		]);
	});

	it("hides the Google daemon's runtime folder, whose tokens are the person's, by binding none of it back", () => {
		const everything: Disk = { kind: () => "folder", entries: () => [] };
		const all = fenceArgs(place, everything);
		expect(all.join(" "), "the runtime folder is emptied").toContain(
			"--tmpfs /run/user/1000",
		);
		expect(
			all.filter((arg) => arg.startsWith("/run/user/1000/google")),
			"nothing of the Google daemon's folder is bound back",
		).toEqual([]);
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

	it("binds the copy of npm's settings without their tokens over them, after the home's binds", () => {
		const npmrc = "/run/user/1000/pi-fence/npmrc";
		const settings = `${place.home}/.npmrc`;
		const given = fenceArgs(
			{ ...place, npmrc },
			diskWith(place.home, [".npmrc", ".config"]),
		);
		const at = given.indexOf(npmrc);
		expect(given.slice(at - 1, at + 2)).toEqual(["--ro-bind", npmrc, settings]);
		expect(
			given.lastIndexOf(settings),
			"no later bind puts the file back",
		).toBe(at + 1);
		expect(
			fenceRefusesRead(settings, place),
			"pi's read tool is refused the file itself",
		).toBe(true);
		expect(args, "with no copy, nothing is bound").not.toContain(npmrc);
	});

	it("binds the session's writable copies of dev's settings and git's global folder, before the hidden entries are emptied", () => {
		const copies = {
			dev: "/run/user/1000/pi-fence/dev/s-1/dev",
			git: "/run/user/1000/pi-fence/dev/s-1/git",
		};
		const settings = `${place.home}/.config/dev`;
		const hiddenFile = `${place.home}/${HIDDEN[0]}`;
		const folders = diskWith(place.home, [".config", ".gitconfig"]);
		const given = fenceArgs(
			{ ...place, devCopies: copies },
			{
				...folders,
				kind: (path) => (path === hiddenFile ? "file" : folders.kind(path)),
			},
		);
		const at = given.indexOf(copies.dev);
		expect(given.slice(at - 1, at + 2)).toEqual([
			"--bind",
			copies.dev,
			settings,
		]);
		const covering = [settings, `${place.home}/.config`, place.home];
		expect(
			given.slice(at + 2).filter((arg) => covering.includes(arg)),
			"no later mount of dev's settings, or a folder holding them, covers the copy",
		).toEqual([]);
		const hidden = given.indexOf(hiddenFile);
		expect(hidden, "no hidden entry was emptied").toBeGreaterThan(-1);
		expect(
			hidden,
			"the hidden entries are emptied after the copy, so one in dev's folder stays hidden",
		).toBeGreaterThan(at);
		const git = given.indexOf(copies.git);
		expect(given.slice(git - 1, git + 2)).toEqual([
			"--bind",
			copies.git,
			copies.git,
		]);
		expect(
			git,
			"git's folder is bound after the runtime folder is emptied",
		).toBeGreaterThan(given.indexOf("/run/user/1000"));
		expect(
			fenceRefusesWrite(settings, place),
			"pi's own tools still never write the person's dev settings",
		).toBe(true);
		expect(args, "with no copies, nothing is bound").not.toContain(copies.dev);

		const none: Disk = {
			kind: (path) => (path === settings ? undefined : "folder"),
			entries: () => [],
		};
		expect(
			fenceArgs({ ...place, devCopies: copies }, none),
			"no mount over dev's settings where the person has none",
		).not.toContain(copies.dev);
	});

	it("binds the npm copy over the file its settings link to, and nothing where there are none", () => {
		const npmrc = "/run/user/1000/pi-fence/npmrc";
		const settings = `${place.home}/.npmrc`;
		const stored = "/nix/store/0000-npmrc";
		const linked = {
			...diskWith(place.home, [".npmrc"], [settings]),
			real: (path: string) => (path === settings ? stored : undefined),
		};
		const given = fenceArgs({ ...place, npmrc }, linked);
		const at = given.indexOf(npmrc);
		expect(given.slice(at - 1, at + 2)).toEqual(["--ro-bind", npmrc, stored]);

		const none: Disk = {
			kind: (path) => (path === settings ? undefined : "folder"),
			entries: () => [],
		};
		expect(fenceArgs({ ...place, npmrc }, none)).not.toContain(npmrc);
		expect(
			fenceRefusesRead(stored, place, linked),
			"pi's read tool is refused the file the settings link to",
		).toBe(true);
	});

	it("empties the file or folder a hidden link leads to, and refuses pi's tools there", () => {
		const vault = `${place.home}/.pi/agent/vault.json`;
		const legacy = `${place.home}/.config/gcloud/legacy_credentials`;
		const storedFile = "/elsewhere/vault.json";
		const storedFolder = "/elsewhere/legacy";
		const linked: Disk = {
			kind: (path) => {
				if (path === vault || path === legacy) return "link";
				return path === storedFile ? "file" : "folder";
			},
			entries: () => [],
			real: (path) => ({ [vault]: storedFile, [legacy]: storedFolder })[path],
		};
		const given = fenceArgs(place, linked);
		const file = given.indexOf(storedFile);
		expect(given.slice(file - 2, file + 1)).toEqual([
			"--ro-bind",
			"/dev/null",
			storedFile,
		]);
		const folder = given.indexOf(storedFolder);
		expect(given.slice(folder - 1, folder + 3)).toEqual([
			"--tmpfs",
			storedFolder,
			"--remount-ro",
			storedFolder,
		]);
		expect(given, "nothing is mounted on the links themselves").not.toContain(
			vault,
		);
		expect(
			fenceRefusesRead(storedFile, place, linked),
			"the stored file a link points at is refused",
		).toBe(true);
		expect(
			fenceRefusesRead(`${storedFolder}/adc.json`, place, linked),
			"a file in the stored folder a link points at is refused",
		).toBe(true);
		expect(
			fenceRefusesRead("/elsewhere/other.json", place, linked),
			"what sits beside the target stays readable",
		).toBe(false);
	});

	// bubblewrap can't make a mount point in a folder it emptied read-only,
	// so a bind there would refuse every command.
	it("leaves a hidden file linked into a hidden folder to the folder", () => {
		const histfile = `${place.home}/.histfile`;
		const zsh = `${place.home}/.local/share/zsh`;
		const stored = `${zsh}/histfile`;
		const linked: Disk = {
			kind: (path) => {
				if (path === histfile) return "link";
				return path === stored ? "file" : "folder";
			},
			entries: () => [],
			real: (path) => (path === histfile ? stored : undefined),
		};
		const given = fenceArgs(place, linked);
		const folder = given.indexOf(zsh);
		expect(given.slice(folder - 1, folder + 3), "the folder emptied").toEqual([
			"--tmpfs",
			zsh,
			"--remount-ro",
			zsh,
		]);
		expect(given, "nothing bound inside the emptied folder").not.toContain(
			stored,
		);
		expect(
			fenceRefusesRead(stored, place, linked),
			"the history still refused to pi's tools",
		).toBe(true);
	});

	it("makes the home folder read-only, binding back writable every hidden entry but the read-only ones and links", () => {
		expect(
			pairs("--ro-bind").find((path) => path?.startsWith(place.home)),
		).toBe(place.home);
		const writable = pairs("--bind").filter((path) =>
			path?.startsWith(place.home),
		);
		expect(writable).toEqual([
			"/home/someone/.cache",
			"/home/someone/.local",
			"/home/someone/.pi",
			// Each folder above a read-only path, bound over itself as it
			// was, so a command can't move it (fence-pins.ts).
			"/home/someone/.local/share",
			"/home/someone/.local/share/direnv",
			"/home/someone/.local/state",
			"/home/someone/.local/state/tec",
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

	// The whole fence, with everything it can lay in the runtime folder:
	// the GitHub door's folder, direnv's settings where `fenceDirenv`
	// writes them, and the quest locks.
	const laidIn = {
		...place,
		githubDoor: githubDoorFolder(place.runtimeDir, "s1"),
		direnv: join(place.runtimeDir, "pi-fence", "direnv"),
	};
	const laidArgs = fenceArgs(laidIn, {
		...diskWith(place.home, ["src", ".config"]),
		questLocks: (runtimeDir) => ({
			folder: join(runtimeDir, "agentic-harness.pi", "quest-locks"),
			ours: true,
		}),
	});
	const laidRules = fenceRules(laidIn);

	it("lets none of the desktop's names through, by mount or by socket, nor a folder above one", () => {
		expect(
			[laidIn.githubDoor, laidIn.direnv, "agentic-harness.pi/quest-locks"].map(
				(part) =>
					part !== undefined && laidArgs.some((arg) => arg.endsWith(part)),
			),
			"the door's, direnv's or the quest locks' mount isn't laid to be checked",
		).toEqual([true, true, true]);
		expect(
			namesReached(laidArgs, laidRules, place.runtimeDir),
			"names the fence must keep out are let through",
		).toEqual([]);
	});

	it("sees the eero daemon's socket let through however a rule or a mount reaches it", () => {
		const folder = join(place.runtimeDir, "eero");
		const everyRuntimeName = NEVER_THROUGH.filter((name) => !isAbsolute(name));
		const emptying = args.indexOf("--perms");
		const cases: [string, string[], string[], readonly string[]][] = [
			[
				"a rule on its folder",
				args,
				[...rules, "--unix", folder],
				["eero/socket"],
			],
			[
				"a rule on its folder with a slash",
				args,
				[...rules, "--unix", `${folder}/`],
				["eero/socket"],
			],
			[
				"a rule on the runtime folder",
				args,
				[...rules, "--unix", place.runtimeDir],
				everyRuntimeName,
			],
			[
				"a read-only bind",
				[...args, "--ro-bind", folder, folder],
				rules,
				["eero/socket"],
			],
			[
				"a bind tried",
				[...args, "--ro-bind-try", folder, folder],
				rules,
				["eero/socket"],
			],
			[
				"a device bind",
				[...args, "--dev-bind", folder, folder],
				rules,
				["eero/socket"],
			],
			[
				"a bind out of the folder",
				[...args, "--ro-bind", folder, "/tmp/eero"],
				rules,
				["eero/socket"],
			],
			[
				"an overlay",
				[...args, "--overlay-src", folder, "--tmp-overlay", folder],
				rules,
				["eero/socket"],
			],
			[
				"an overlay out of the folder",
				[...args, "--overlay-src", folder, "--tmp-overlay", "/tmp/eero"],
				rules,
				["eero/socket"],
			],
			[
				"/run bound after the tmpfs",
				[...args, "--ro-bind", "/run", "/run"],
				rules,
				everyRuntimeName,
			],
			[
				"/run bound before the tmpfs",
				[
					...args.slice(0, emptying),
					"--ro-bind",
					"/run",
					"/run",
					...args.slice(emptying),
				],
				rules,
				[],
			],
			[
				"its folder bound out before the tmpfs",
				[
					...args.slice(0, emptying),
					"--ro-bind",
					folder,
					"/tmp/eero",
					...args.slice(emptying),
				],
				rules,
				["eero/socket"],
			],
			[
				"a stand-in bound over it",
				[...args, "--ro-bind", "/dev/null", join(folder, "socket")],
				rules,
				[],
			],
		];
		for (const [how, given, ruled, reached] of cases) {
			expect(
				namesReached(given, ruled, place.runtimeDir),
				`${how} was judged wrongly`,
			).toEqual(reached);
		}
	});

	it("sees a socket in a folder it keeps out, a wildcard's match and an absolute socket carried elsewhere", () => {
		const credentials = "/run/systemd/io.systemd.Credentials";
		const cases: [string, string[], string[], readonly string[]][] = [
			[
				"a bind in a kept-out folder",
				[
					...args,
					"--ro-bind",
					join(place.runtimeDir, "keyring", "control"),
					join(place.runtimeDir, "keyring", "control"),
				],
				rules,
				["keyring"],
			],
			[
				"a rule in a kept-out folder",
				args,
				[...rules, "--unix", join(place.runtimeDir, "gnupg", "S.gpg-agent")],
				["gnupg"],
			],
			[
				"a rule on a wildcard's match",
				args,
				[...rules, "--unix", join(place.runtimeDir, "wayland-1")],
				["wayland-*"],
			],
			[
				"a bind of a wildcard's match",
				[
					...args,
					"--ro-bind",
					join(place.runtimeDir, "pipewire-0"),
					join(place.runtimeDir, "pipewire-0"),
				],
				rules,
				["pipewire-*"],
			],
			[
				"a rule on a near miss of a wildcard",
				args,
				[...rules, "--unix", join(place.runtimeDir, "waylandx")],
				[],
			],
			[
				"an absolute socket carried onto a ruled path",
				[
					...args,
					"--ro-bind",
					credentials,
					join(place.runtimeDir, "nix-untrusted.sock"),
				],
				rules,
				[credentials],
			],
		];
		for (const [how, given, ruled, reached] of cases) {
			expect(
				namesReached(given, ruled, place.runtimeDir),
				`${how} was judged wrongly`,
			).toEqual(reached);
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

	it("keeps a machine's node's state read-only, since it judges each carry by it", () => {
		// Its claims and the fences it has seen, as the Mac's fence hides them.
		expect(pairs("--ro-bind")).toContain(
			join(place.home, ".local/state/mycelium"),
		);
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

	it("keeps every quest's shared folder read-only but the session's own, as its scratches are", () => {
		const share = {
			root: "/home/someone/.cache/pi/quest-shares",
			own: "/home/someone/.cache/pi/quest-shares/QEST-1",
		};
		const given = fenceArgs(
			{ ...place, share },
			diskWith(place.home, [".cache"]),
		);
		const root = given.lastIndexOf(share.root);
		const own = given.lastIndexOf(share.own);
		expect(given[root - 2]).toBe("--ro-bind");
		expect(given[own - 2]).toBe("--bind");
		expect(
			root > given.lastIndexOf("/home/someone/.cache"),
			"the shared folders are bound over the cache's writable bind",
		).toBe(true);
		expect(own > root, "the session's own is bound back after").toBe(true);

		const at = { ...place, share };
		expect(
			fenceRefusesWrite(`${share.root}/QEST-2/.envrc`, at),
			"another quest's shared folder is read-only to pi's file tools too",
		).toBe(true);
		expect(
			fenceRefusesWrite(`${share.own}/notes.md`, at),
			"the session's own shared folder stays writable",
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
			"/run/user/1000/pi-agent",
			"/run/user/1000/daemons/jobs-broker.sock",
			"/run/user/1000/pi-clipboard",
			"/run/user/1000/pi-fence-display",
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
			// Above dbus's and nvim's, pinned so it can't be moved (fence-pins.ts).
			`${home}/.local/share`,
			`${home}/.kube/cache`,
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
			// The person's cloud logins, hidden rather than kept writable.
			".kube/gke_gcloud_auth_plugin_cache",
			".aws/sso/cache/token.json",
			".aws/cli/cache/role.json",
		]) {
			expect(refuses(path), `${path} was writable`).toBe(true);
		}
		for (const path of [
			".kube/cache/discovery",
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

	it("empties the logins pi's own tools read outside the fence, for commands and pi's file tools alike", () => {
		const logins = [
			`${home}/.config/agentic-harness/google/credentials.json`,
			`${home}/.config/agentic-harness/slack/credentials.json`,
			`${home}/.pi/agent/vault.json`,
			`${home}/.local/state/gnome-keyring/login.cred`,
			`${home}/.local/state/eero/session.cred`,
		];
		const given = fenceArgs(
			{ home, runtimeDir: "/run/user/1000" },
			diskOf([...logins, `${home}/.config/agentic-harness/settings.json`]),
		);
		const place = { home, runtimeDir: "/run/user/1000" };
		for (const login of logins) {
			const at = given.lastIndexOf(login);
			expect(given.slice(at - 2, at + 1), login).toEqual([
				"--ro-bind",
				"/dev/null",
				login,
			]);
			expect(fenceRefusesRead(login, place), login).toBe(true);
		}
		expect(
			fenceRefusesRead(`${home}/.config/agentic-harness/settings.json`, place),
			"the harness's other settings stay readable",
		).toBe(false);
	});

	it("empties the Aquifer cells' state whole, where each basin's provider login lies, for commands and pi's file tools alike", () => {
		const cells = `${home}/.local/state/aquifer-cell`;
		const login = `${cells}/basin-1/aquifer/credentials/basin-1.json`;
		const given = fenceArgs(
			{ home, runtimeDir: "/run/user/1000" },
			diskOf([login]),
		);
		const at = given.indexOf(cells);

		expect(
			given.slice(at - 1, at + 3),
			"the folder, empty and read-only",
		).toEqual(["--tmpfs", cells, "--remount-ro", cells]);
		expect(
			fenceRefusesRead(login, { home, runtimeDir: "/run/user/1000" }),
			"pi's read tool is refused the login",
		).toBe(true);
	});

	it("empties the person's own cloud login, a folder of them whole, since fenced gcloud reads its own", () => {
		const gcloud = `${home}/.config/gcloud`;
		const legacy = `${gcloud}/legacy_credentials`;
		const files = [
			`${gcloud}/application_default_credentials.json`,
			`${gcloud}/credentials.db`,
			`${gcloud}/access_tokens.db`,
			`${home}/.gsutil/credstore2`,
		];
		const given = fenceArgs(
			{ home, runtimeDir: "/run/user/1000" },
			diskOf([
				...files,
				`${legacy}/someone/adc.json`,
				`${gcloud}/configurations/config_default`,
			]),
		);
		const place = { home, runtimeDir: "/run/user/1000" };
		for (const file of files) {
			const at = given.lastIndexOf(file);
			expect(given.slice(at - 2, at + 1), file).toEqual([
				"--ro-bind",
				"/dev/null",
				file,
			]);
		}
		const at = given.indexOf(legacy);
		expect(
			given.slice(at - 1, at + 3),
			"the folder, empty and read-only",
		).toEqual(["--tmpfs", legacy, "--remount-ro", legacy]);
		expect(
			fenceRefusesRead(`${legacy}/someone/adc.json`, place),
			"pi's read tool is refused what the folder holds",
		).toBe(true);
		expect(
			fenceRefusesRead(`${gcloud}/configurations/config_default`, place),
			"gcloud's other settings stay readable",
		).toBe(false);
		expect(
			fenceRefusesRead(`${gcloud}/legacy_credentials_other`, place),
			"a name that only starts the same isn't the folder",
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

describe("what node reads back as compiled code outside the fence", () => {
	// A cache entry, or a module node's require finds last, runs at the
	// next start of a host or pi, unfenced (04TNWT, 19 November).
	const home = "/home/someone";
	const place = { home, runtimeDir: undefined };
	const disk = diskWith(home, [".local", ".cache", ".node_modules"]);
	const args = fenceArgs(place, disk);

	it("sends a write to node's or jiti's cache in /tmp to the fence's own tmpfs", () => {
		for (const folder of ["/tmp/node-compile-cache", "/tmp/jiti"]) {
			const source = args.indexOf(folder);
			expect(args.slice(source - 1, source + 3)).toEqual([
				"--overlay-src",
				folder,
				"--tmp-overlay",
				folder,
			]);
			// After `/` is bound, which would otherwise cover it again.
			expect(source).toBeGreaterThan(args.indexOf("/"));
		}
	});

	it("makes a missing cache a tmpfs of its own, and refuses a link left there", () => {
		const missing = fenceArgs(place, {
			kind: () => undefined,
			entries: () => [],
		});
		const at = missing.indexOf("/tmp/jiti");
		expect(missing.slice(at - 1, at + 1)).toEqual(["--tmpfs", "/tmp/jiti"]);
		// One of ours is set aside before (setAsidePlanted); one still there
		// would lead node and jiti outside wherever it points.
		expect(() =>
			fenceArgs(place, diskWith(home, [".local"], ["/tmp/jiti"])),
		).toThrow(/\/tmp\/jiti is a link/);
	});

	it("says why before the fence is laid, so a link left there is refused as any refusal is", () => {
		const folders = ["/tmp/node-compile-cache", "/tmp/jiti"];
		expect(plantedCache(folders, disk)).toBeUndefined();
		expect(
			plantedCache(folders, { kind: () => undefined, entries: () => [] }),
		).toBeUndefined();
		expect(
			plantedCache(folders, diskWith(home, [".local"], ["/tmp/jiti"])),
		).toMatch(/^the fence won't start: \/tmp\/jiti is a link/);
	});

	it("binds each node_modules node searches above pi's code read-only", () => {
		for (const folder of [
			".pi/node_modules",
			".local/node_modules",
			".local/share/node_modules",
			".local/state/node_modules",
		]) {
			const path = `${home}/${folder}`;
			const at = args.lastIndexOf(path) - 1;
			expect(args.slice(at - 1, at + 2), `${folder} isn't read-only`).toEqual([
				"--ro-bind",
				path,
				path,
			]);
		}
		expect(foldersMadeFirst(home)).toContain(
			`${home}/.local/share/node_modules`,
		);
	});

	it("binds neither of node's home module folders back writable", () => {
		expect(READ_ONLY).toEqual(
			expect.arrayContaining([".node_modules", ".node_libraries"]),
		);
		const bound = args.flatMap((arg, at) =>
			arg === "--bind" ? [args[at + 1]] : [],
		);
		expect(bound).not.toContain(`${home}/.node_modules`);
	});

	it("refuses pi's file tools every cache and module folder", () => {
		for (const path of [
			"/tmp/node-compile-cache/v22/entry",
			"/tmp/jiti/fence.0b681951.mjs",
			`${home}/.local/share/node_modules/bufferutil/index.js`,
			`${home}/.pi/node_modules/bufferutil/index.js`,
			`${home}/.local/state/pi/agentic-harness.pi/host-compile/work-1/entry`,
			`${home}/.local/state/pi/agentic-harness.pi/node-compile-cache/entry`,
			`${home}/.node_modules/bufferutil.js`,
			`${home}/.node_libraries/bufferutil.js`,
		]) {
			expect(fenceRefusesWrite(path, place, disk), `${path} was writable`).toBe(
				true,
			);
		}
	});
});
