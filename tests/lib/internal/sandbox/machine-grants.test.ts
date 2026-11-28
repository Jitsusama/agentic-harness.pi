/**
 * A machine adds to the strict profile only through a file nothing but
 * root could have written, and a file anyone else could have written, or
 * one of the wrong shape, grants nothing and says why.
 */

import { describe, expect, it } from "vitest";
import {
	type GrantDisk,
	type GrantStat,
	MACHINE_GRANTS,
	type MachineGrants,
	machineGrants as readGrants,
	rootMapped,
	rootSeenAsIn,
	sayingOnce,
} from "../../../../lib/internal/sandbox/machine-grants.ts";

const FOLDER = "/etc/pi-sandbox";

const ROOTS_FILE: GrantStat = { uid: 0, mode: 0o100644, kind: "file" };
const ROOTS_FOLDER: GrantStat = { uid: 0, mode: 0o40755, kind: "folder" };

const WORLD = JSON.stringify({
	read: ["/run/worker-signing", "/run/user/1001/delta"],
	write: ["/world", "/dev/kvm"],
});

/** The account whose grants are read, and its home. */
const HOME = "/home/worker";

/**
 * The grants `given` holds at `path`, for `home` naming `repositoryHomes`:
 * never this machine's own home or settings, which the test doesn't own.
 */
function machineGrants(
	path: string,
	given: GrantDisk,
	home: string = HOME,
	repositoryHomes: readonly string[] = [],
): MachineGrants {
	return readGrants({ home, repositoryHomes }, path, given);
}

/**
 * A disk holding `text` at the grant's path, laid as `file` and `folder`
 * say; `"missing"` for a path with nothing there. Every other path in
 * `links` is a link, and every one in `others` a folder. Every folder
 * may be searched.
 */
function disk(
	text: string | undefined,
	laidFile: GrantStat | "missing" = ROOTS_FILE,
	laidFolder: GrantStat | "missing" = ROOTS_FOLDER,
	rootSeenAs = 0,
	links: readonly string[] = [],
	others: readonly string[] = [],
): GrantDisk & { said: string[] } {
	const file = laidFile === "missing" ? undefined : laidFile;
	const folder = laidFolder === "missing" ? undefined : laidFolder;
	const said: string[] = [];
	return {
		said,
		lstat: (path) =>
			path === MACHINE_GRANTS
				? file
				: path === FOLDER
					? folder
					: links.includes(path)
						? { ...ROOTS_FOLDER, kind: "link" }
						: others.includes(path)
							? ROOTS_FOLDER
							: undefined,
		read: (path) => (path === MACHINE_GRANTS ? text : undefined),
		say: (why) => said.push(why),
		rootSeenAs: () => rootSeenAs,
		searchable: () => true,
	};
}

/** Root's file and folder as a namespace that doesn't map root shows them. */
const NOBODYS_FILE: GrantStat = { ...ROOTS_FILE, uid: 65534 };
const NOBODYS_FOLDER: GrantStat = { ...ROOTS_FOLDER, uid: 65534 };

const NONE = { read: [], write: [] };

describe("a machine's grants to the strict profile", () => {
	it("are honoured from a root-owned file in a root-owned folder", () => {
		const given = disk(WORLD);
		expect(machineGrants(MACHINE_GRANTS, given), "the grant").toEqual({
			read: ["/run/worker-signing", "/run/user/1001/delta"],
			write: ["/world", "/dev/kvm"],
		});
		expect(given.said, "nothing said of a good grant").toEqual([]);
	});

	it("are honoured inside a namespace where root shows as overflow", () => {
		const given = disk(WORLD, NOBODYS_FILE, NOBODYS_FOLDER, 65534);
		expect(machineGrants(MACHINE_GRANTS, given).write, "the grant").toEqual([
			"/world",
			"/dev/kvm",
		]);
	});

	it("are none for an overflow owner where root is mapped", () => {
		const given = disk(WORLD, NOBODYS_FILE, NOBODYS_FOLDER, 0);
		expect(machineGrants(MACHINE_GRANTS, given), "no grant").toEqual(NONE);
		expect(given.said.join(""), "said why").toContain("isn't root's");
	});

	it("are none for root's uid inside a namespace that doesn't map root", () => {
		const given = disk(WORLD, ROOTS_FILE, ROOTS_FOLDER, 65534);
		expect(machineGrants(MACHINE_GRANTS, given), "no grant").toEqual(NONE);
	});

	it.each([
		["the first namespace", "0 0 4294967295", true],
		["a fence mapping only the session", "1001 1001 1", false],
		["a range starting at root", "0 100000 65536", true],
		["no lines", "", false],
	])("see whether root is mapped in %s", (_, map, mapped) => {
		expect(rootMapped(map), map).toBe(mapped);
	});

	it("are none, said of nothing, where the machine has no file", () => {
		const given = disk(undefined, "missing");
		expect(machineGrants(MACHINE_GRANTS, given), "no grant").toEqual(NONE);
		expect(given.said, "a missing file is no fault").toEqual([]);
	});

	it("are none, and say so, where the file's folder can't be searched", () => {
		// The file then shows as missing whether or not the machine laid one.
		const given = { ...disk(undefined, "missing"), searchable: () => false };
		expect(machineGrants(MACHINE_GRANTS, given), "no grant").toEqual(NONE);
		expect(given.said.join("\n"), "why it grants nothing").toContain(
			`the strict profile takes no grant from ${MACHINE_GRANTS}: its folder can't be searched, so whether it grants anything can't be told`,
		);
	});

	it.each([
		[
			"a file not root's",
			{ ...ROOTS_FILE, uid: 1001 },
			ROOTS_FOLDER,
			"the file isn't root's",
		],
		[
			"a group-writable file",
			{ ...ROOTS_FILE, mode: 0o100664 },
			ROOTS_FOLDER,
			"the file is writable by more than root",
		],
		[
			"a world-writable file",
			{ ...ROOTS_FILE, mode: 0o100646 },
			ROOTS_FOLDER,
			"the file is writable by more than root",
		],
		[
			"a linked file",
			{ ...ROOTS_FILE, kind: "link" as const },
			ROOTS_FOLDER,
			"the file is a link",
		],
		[
			"a folder not root's",
			ROOTS_FILE,
			{ ...ROOTS_FOLDER, uid: 1001 },
			"its folder isn't root's",
		],
		[
			"a group-writable folder",
			ROOTS_FILE,
			{ ...ROOTS_FOLDER, mode: 0o40775 },
			"its folder is writable by more than root",
		],
		[
			"a linked folder",
			ROOTS_FILE,
			{ ...ROOTS_FOLDER, kind: "link" as const },
			"its folder is a link",
		],
	])("grant nothing from %s, and say why", (_, file, folder, why) => {
		const given = disk(WORLD, file, folder);
		expect(machineGrants(MACHINE_GRANTS, given), "no grant").toEqual(NONE);
		expect(given.said.join("\n"), "why it grants nothing").toContain(why);
	});

	it.each([
		["a path that isn't a string", { read: [7] }],
		["a list that isn't a list", { write: "/world" }],
	])("grant nothing from a file naming %s", (_, shape) => {
		const given = disk(JSON.stringify(shape));
		expect(machineGrants(MACHINE_GRANTS, given, HOME), "no grant").toEqual(
			NONE,
		);
		expect(given.said.join("\n"), "why it grants nothing").toContain(
			"read and write must each be a list of paths",
		);
	});

	it.each([
		["a relative path", "write", "world", "isn't an absolute path"],
		["a path not in its plainest form", "write", "/world/../x", "plainest"],
		["the root folder", "write", "/", "other than /"],
		["a path with a trailing slash", "read", "/world/", "plainest"],
		["a comma", "read", "/world,/home/worker", "holds a comma"],
		["this account's home", "read", HOME, "a home (/home/*)"],
		["a folder in a home", "write", "/home/worker/cache", "a home"],
		["a home elsewhere", "write", "/srv/me", "a home (/srv/me)"],
		["a folder holding a home", "write", "/srv", "a home (/srv/me)"],
		["the folder of homes", "write", "/home", "a home"],
		["root's home", "read", "/root/x", "a home (/root)"],
		["a runtime folder", "read", "/run/user/1001", "/run/user/*"],
		["a folder holding runtime folders", "write", "/run", "/run/user/*"],
		["/etc", "read", "/etc", "is or holds /etc"],
		["/nix", "write", "/nix", "is or holds /nix"],
		["/usr", "read", "/usr", "is or holds /usr"],
		["/var", "write", "/var", "is or holds /var"],
		["/tmp", "write", "/tmp", "is or holds /tmp"],
		["/dev/shm", "write", "/dev/shm", "is or holds /dev/shm"],
		[
			"/dev itself, which holds /dev/pts the fence needs whole",
			"write",
			"/dev",
			"is or holds /dev/pts",
		],
		["a path in /proc", "read", "/proc/1/environ", "lies in /proc"],
		["a path in /sys", "write", "/sys/kernel", "lies in /sys"],
		["a device to read", "read", "/dev/kvm", "is a device"],
		["a folder in /tmp", "write", "/tmp/lane", "lies in /tmp"],
		["a folder in /var/tmp", "read", "/var/tmp/x", "lies in /var/tmp"],
		["a file in /dev/shm", "write", "/dev/shm/x", "lies in /dev/shm"],
		[
			"a folder written in a runtime folder",
			"write",
			"/run/user/1001/delta",
			"lies in a runtime folder",
		],
		[
			"the agent proxy's folder",
			"read",
			"/run/user/1001/pi-agent",
			"lies in /run/user/*/pi-agent",
		],
		[
			"Nix's door",
			"read",
			"/run/user/1001/nix-untrusted.sock",
			"/run/user/*/nix-untrusted.sock",
		],
		[
			"a folder holding the jobs broker",
			"read",
			"/run/user/1001/daemons",
			"holds or lies in /run/user/*/daemons/jobs-broker.sock",
		],
		[
			"pi's folder in the runtime folder",
			"read",
			"/run/user/1001/pi-fence/direnv",
			"/run/user/*/pi-fence",
		],
	])(
		"grant nothing from a file naming %s, and name it",
		(_, use, entry, why) => {
			const given = disk(JSON.stringify({ [use]: [entry] }));
			const home = entry.startsWith("/srv") ? "/srv/me" : HOME;
			expect(machineGrants(MACHINE_GRANTS, given, home), "no grant").toEqual(
				NONE,
			);
			const saidAll = given.said.join("\n");
			expect(saidAll, "names the entry").toContain(
				`${JSON.stringify(entry)} under ${use}`,
			);
			expect(saidAll, "why it grants nothing").toContain(why);
		},
	);

	it("grant nothing from a path passing through a link", () => {
		const given = disk(
			JSON.stringify({ read: ["/var2/run/x"] }),
			ROOTS_FILE,
			ROOTS_FOLDER,
			0,
			["/var2/run"],
			["/var2"],
		);
		expect(machineGrants(MACHINE_GRANTS, given, HOME), "no grant").toEqual(
			NONE,
		);
		expect(given.said.join("\n"), "names the link").toContain(
			"passes through a link at /var2/run",
		);
	});

	it("grant a path whose folders are plain", () => {
		const given = disk(
			JSON.stringify({ write: ["/world/trees"] }),
			ROOTS_FILE,
			ROOTS_FOLDER,
			0,
			[],
			["/world", "/world/trees"],
		);
		expect(machineGrants(MACHINE_GRANTS, given, HOME).write, "granted").toEqual(
			["/world/trees"],
		);
	});

	it.each([
		["text that isn't JSON", "{read:", "it isn't JSON"],
		["a list where an object belongs", "[]", "it isn't {"],
		["a file it can't read", undefined, "it can't be read"],
	])("grant nothing from %s", (_, text, why) => {
		const given = disk(text);
		expect(machineGrants(MACHINE_GRANTS, given), "no grant").toEqual(NONE);
		expect(given.said.join("\n"), "why it grants nothing").toContain(why);
	});

	it.each([
		["the repository home itself", "/world/git"],
		["a folder holding it", "/world"],
		["a folder in it", "/world/git/hooks"],
	])(
		"grant nothing from a write naming %s of a repository home",
		(_, entry) => {
			const given = disk(JSON.stringify({ write: [entry] }));
			expect(
				machineGrants(MACHINE_GRANTS, given, HOME, ["/world/git"]),
				"no grant",
			).toEqual(NONE);
			expect(given.said.join("\n"), "names the repository home").toContain(
				`${JSON.stringify(entry)} under write is, holds or lies in a repository home (/world/git)`,
			);
		},
	);

	it("grant a read of a repository home, which the fence lays read-only anyway", () => {
		const given = disk(JSON.stringify({ read: ["/world/git"] }));
		expect(
			machineGrants(MACHINE_GRANTS, given, HOME, ["/world/git"]).read,
			"granted",
		).toEqual(["/world/git"]);
	});

	it("grant a write beside a repository home it neither holds nor lies in", () => {
		const given = disk(JSON.stringify({ write: ["/world/trees"] }));
		expect(
			machineGrants(MACHINE_GRANTS, given, HOME, ["/world/git"]).write,
			"granted",
		).toEqual(["/world/trees"]);
	});

	it.each([
		[
			"a read",
			{ read: ["/world/keys"], write: ["/world"] },
			'"/world/keys" under read',
		],
		[
			"the same read",
			{ read: ["/world"], write: ["/world"] },
			'"/world" under read',
		],
		[
			"another write",
			{ write: ["/world", "/world/trees"] },
			'"/world/trees" under write',
		],
		[
			"the same write twice",
			{ write: ["/world", "/world"] },
			'"/world" under write',
		],
	])(
		"grant nothing where %s lies within a write, and name both",
		(_, shape, inner) => {
			const given = disk(JSON.stringify(shape));
			expect(machineGrants(MACHINE_GRANTS, given), "no grant").toEqual(NONE);
			expect(given.said.join("\n"), "names both").toContain(
				`${inner} lies within "/world" under write`,
			);
		},
	);

	it("grant a folder within a runtime folder or /etc", () => {
		const given = disk(
			JSON.stringify({ read: ["/run/user/1001/delta", "/etc/pi-x"] }),
		);
		expect(machineGrants(MACHINE_GRANTS, given, HOME).read, "granted").toEqual([
			"/run/user/1001/delta",
			"/etc/pi-x",
		]);
	});

	it("grant nothing from a file naming a key it doesn't know", () => {
		const given = disk(JSON.stringify({ read: [], writes: ["/world"] }));
		expect(machineGrants(MACHINE_GRANTS, given), "no grant").toEqual(NONE);
		expect(given.said.join("\n"), "why it grants nothing").toContain(
			"it names writes, which is neither read nor write",
		);
	});

	it("grant only what a list names, an absent one granting nothing", () => {
		const given = disk(JSON.stringify({ read: ["/run/worker-signing"] }));
		expect(machineGrants(MACHINE_GRANTS, given), "the grant").toEqual({
			read: ["/run/worker-signing"],
			write: [],
		});
	});
});

describe("a machine's grants beside the node's worker socket", () => {
	/** A worker socket outside /run, so no other rule refuses its folder. */
	const SOCKET = "/srv/node/work-worker.sock";

	/** The grants `entry` to `use` makes, the fence letting `workerSocket` through. */
	const granted = (
		use: "read" | "write",
		entry: string,
		workerSocket?: string,
	) => {
		const given = disk(JSON.stringify({ [use]: [entry] }));
		const grants = readGrants(
			{ home: HOME, repositoryHomes: [], workerSocket },
			MACHINE_GRANTS,
			given,
		);
		return { grants, said: given.said.join("\n") };
	};

	it.each([
		["the socket's folder", "write", "/srv/node"],
		["a path in it", "read", "/srv/node/x"],
		["a folder holding it", "read", "/srv"],
	] as const)(
		"grant nothing from a file naming %s, which the fence binds read-only",
		(_, use, entry) => {
			const { grants, said } = granted(use, entry, SOCKET);
			expect(grants, "no grant").toEqual(NONE);
			expect(said, "names the entry").toContain(
				`${JSON.stringify(entry)} under ${use}`,
			);
			expect(said, "why it grants nothing").toContain(
				"is, holds or lies in the worker socket's folder (/srv/node)",
			);
		},
	);

	it("grant the same folder where the fence lets no worker socket through", () => {
		expect(granted("write", "/srv/node").grants, "granted").toEqual({
			read: [],
			write: ["/srv/node"],
		});
	});
});

describe("a machine's grants through folders any account may write", () => {
	/**
	 * A disk granting `entry` to `use`, where each folder in `laid` has
	 * its mode and every other along the way is root's and plain.
	 */
	const granted = (
		use: "read" | "write",
		entry: string,
		laid: Readonly<Record<string, number>>,
		plain: readonly string[] = [],
	) => {
		const given = disk(
			JSON.stringify({ [use]: [entry] }),
			ROOTS_FILE,
			ROOTS_FOLDER,
			0,
			[],
			plain,
		);
		const lstat = given.lstat;
		given.lstat = (path) => {
			const mode = laid[path];
			return mode === undefined ? lstat(path) : { ...ROOTS_FOLDER, mode };
		};
		return {
			grants: machineGrants(MACHINE_GRANTS, given),
			said: given.said.join("\n"),
		};
	};

	it.each([
		["/run/lock, sticky and open to all", "write", "/run/lock", "/run/lock"],
		["a folder in /run/lock", "read", "/run/lock/x", "/run/lock"],
		["/dev/mqueue", "write", "/dev/mqueue", "/dev/mqueue"],
		["a missing folder in an open one", "write", "/srv/open/lane", "/srv/open"],
	] as const)(
		"grant nothing from a file naming %s, and name the folder",
		(_, use, entry, open) => {
			const { grants, said } = granted(
				use,
				entry,
				{ "/run/lock": 0o41777, "/dev/mqueue": 0o41777, "/srv/open": 0o40777 },
				["/run", "/dev", "/srv"],
			);
			expect(grants, "no grant").toEqual(NONE);
			expect(said, "names the entry").toContain(
				`${JSON.stringify(entry)} under ${use}`,
			);
			expect(said, "names the open folder").toContain(
				`passes through ${open}, a folder any account may write`,
			);
		},
	);

	it("grant a path through a folder only its group may write", () => {
		const { grants } = granted(
			"write",
			"/srv/team/lane",
			{
				"/srv/team": 0o40775,
			},
			["/srv", "/srv/team/lane"],
		);
		expect(grants.write, "granted").toEqual(["/srv/team/lane"]);
	});
});

describe("a machine's grants over what the fence covers after them", () => {
	it.each([
		["the system bus's folder", "read", "/run/dbus", "/run/dbus"],
		[
			"the system bus's socket",
			"read",
			"/run/dbus/system_bus_socket",
			"/run/dbus",
		],
	] as const)(
		"grant nothing from a file naming %s, which the fence hides after the grants",
		(_, use, entry, covered) => {
			const given = disk(JSON.stringify({ [use]: [entry] }));
			expect(machineGrants(MACHINE_GRANTS, given), "no grant").toEqual(NONE);
			const said = given.said.join("\n");
			expect(said, "names the entry").toContain(
				`${JSON.stringify(entry)} under ${use}`,
			);
			expect(said, "why it grants nothing").toContain(
				`is, holds or lies in ${covered}, which the fence covers after the grants`,
			);
		},
	);
});

describe("a World cloud node's grants, as its file is laid", () => {
	/** The grants file a World cloud node lays, its tokens' folders only read. */
	const NODE_FILE = {
		read: [
			"/run/worker-signing",
			"/run/user/1001/delta",
			"/run/user/1001/dev-cloudsmith",
		],
		write: ["/world", "/dev/kvm"],
	};

	/**
	 * The node's disk under `grants`: every folder along each entry root's
	 * and closed, the worker's runtime folder its own, /dev/kvm a device.
	 */
	const onNode = (grants: unknown) => {
		const given = disk(JSON.stringify(grants));
		const lstat = given.lstat;
		const folders = [
			"/run",
			"/run/worker-signing",
			"/run/user",
			"/run/user/1001/delta",
			"/run/user/1001/dev-cloudsmith",
			"/world",
			"/dev",
		];
		given.lstat = (path) =>
			path === "/dev/kvm"
				? { uid: 0, mode: 0o20666, kind: "other" }
				: path === "/run/user/1001"
					? { uid: 1001, mode: 0o40700, kind: "folder" }
					: folders.includes(path)
						? ROOTS_FOLDER
						: lstat(path);
		return { grants: machineGrants(MACHINE_GRANTS, given), said: given.said };
	};

	it("are granted whole, every path walked on its disk", () => {
		const { grants, said } = onNode(NODE_FILE);
		expect(grants, "the node's grants").toEqual(NODE_FILE);
		expect(said, "nothing said of the node's file").toEqual([]);
	});

	it("grant nothing where the tokens' folders are written, since a command could plant the next one's token", () => {
		const { grants, said } = onNode({
			read: [],
			write: [
				"/world",
				"/dev/kvm",
				"/run/user/1001/delta",
				"/run/user/1001/dev-cloudsmith",
			],
		});
		expect(grants, "no grant").toEqual(NONE);
		expect(said.join("\n"), "names the token folder written").toContain(
			'"/run/user/1001/delta" under write lies in a runtime folder',
		);
	});
});

describe("a machine's grants beside a session's runtime folder outside /run/user", () => {
	/** The session's runtime folder, where no account's lies by default. */
	const RUNTIME = "/srv/run";

	/** What `entry` granted to `use` gives a session whose runtime folder is `runtimeDir`. */
	const granted = (
		use: "read" | "write",
		entry: string,
		runtimeDir = RUNTIME,
	) => {
		const given = disk(
			JSON.stringify({ [use]: [entry] }),
			ROOTS_FILE,
			ROOTS_FOLDER,
			0,
			[],
			["/srv", "/srv/run", "/srv/elsewhere"],
		);
		return {
			grants: readGrants(
				{ home: HOME, runtimeDir, repositoryHomes: [] },
				MACHINE_GRANTS,
				given,
			),
			said: given.said.join("\n"),
		};
	};

	it.each([
		["the runtime folder itself", "read", RUNTIME, `is or holds ${RUNTIME}`],
		["a folder holding it", "read", "/srv", `is or holds ${RUNTIME}`],
		[
			"a folder written in it",
			"write",
			`${RUNTIME}/delta`,
			`lies in a runtime folder (${RUNTIME})`,
		],
		[
			"a door the fence lets through",
			"read",
			`${RUNTIME}/pi-agent`,
			`lies in ${RUNTIME}/pi-agent`,
		],
		[
			"pi's own folder in it",
			"read",
			`${RUNTIME}/pi-fence/x`,
			`lies in ${RUNTIME}/pi-fence`,
		],
	] as const)("grant nothing from a file naming %s", (_, use, entry, why) => {
		const { grants, said } = granted(use, entry);
		expect(grants, "no grant").toEqual(NONE);
		expect(said, "why it grants nothing").toContain(why);
	});

	it("grant a folder beside it, and a token folder in it read", () => {
		expect(
			granted("write", "/srv/elsewhere").grants.write,
			"beside it",
		).toEqual(["/srv/elsewhere"]);
		expect(
			granted("read", `${RUNTIME}/delta`).grants.read,
			"read in it",
		).toEqual([`${RUNTIME}/delta`]);
	});

	it("judge beside no runtime folder named other than in its plainest absolute form", () => {
		expect(
			granted("read", "/srv/run", "srv/run").grants.read,
			"a relative one",
		).toEqual(["/srv/run"]);
		expect(
			granted("read", "/srv/run", "/srv/run/").grants.read,
			"one ending in a slash",
		).toEqual(["/srv/run"]);
	});
});

describe("the owner root's files show as", () => {
	/** Reads answering `files` by path, none for any other. */
	const reading = (files: Readonly<Record<string, string>>) => (path: string) =>
		files[path];

	it.each([
		["no namespace to be in", {}, 0],
		["root mapped", { "/proc/self/uid_map": "0 0 4294967295\n" }, 0],
		[
			"root unmapped, the kernel naming its overflow",
			{
				"/proc/self/uid_map": "1001 1001 1\n",
				"/proc/sys/kernel/overflowuid": "65000\n",
			},
			65000,
		],
		[
			"root unmapped, the kernel naming none",
			{ "/proc/self/uid_map": "1001 1001 1\n" },
			65534,
		],
	] as const)("is what it should be with %s", (_, files, uid) => {
		expect(rootSeenAsIn(reading(files)), "root's files show as").toBe(uid);
	});
});

describe("a refusal said", () => {
	it("is written once for each reason, however often it is said", () => {
		const written: string[] = [];
		const say = sayingOnce((text) => written.push(text));
		say("first");
		say("first");
		say("second");
		expect(written, "each reason once").toEqual([
			"pi: first\n",
			"pi: second\n",
		]);
	});
});
