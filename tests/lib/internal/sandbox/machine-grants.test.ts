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
	machineGrants,
	rootMapped,
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
 * A disk holding `text` at the grant's path, laid as `file` and `folder`
 * say; `"missing"` for a path with nothing there. Every other path in
 * `links` is a link, and every one in `others` a folder.
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
		["/dev itself", "write", "/dev", "is or holds /dev/pts"],
		["a path in /proc", "read", "/proc/1/environ", "lies in /proc"],
		["a path in /sys", "write", "/sys/kernel", "lies in /sys"],
		["a device to read", "read", "/dev/kvm", "is a device"],
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
