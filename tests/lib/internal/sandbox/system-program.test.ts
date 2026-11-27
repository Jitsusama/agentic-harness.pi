/**
 * Programs that run outside a sandbox come only from folders root alone
 * writes: a fenced command can plant one earlier on PATH, or add one to
 * the Nix store as an untrusted client, and neither may be taken.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FENCE } from "../../../../lib/internal/fence/fence.ts";
import {
	MOST_LINKS,
	mostLinksOn,
} from "../../../../lib/internal/sandbox/leads-to.ts";
import { sandboxFor } from "../../../../lib/internal/sandbox/sandbox.ts";
import {
	type Look,
	noOwner,
	notKept,
	rootOwners,
	sealedPath,
	systemProgram,
	trustsNoOwner,
} from "../../../../lib/internal/sandbox/system-program.ts";

interface Node {
	uid: number;
	mode: number;
	link?: string;
}

/** A file system of `nodes` by path, root's unless they say otherwise. */
function disk(nodes: Record<string, Partial<Node>>): Look {
	const at = (path: string): Node => {
		const node = nodes[path];
		if (node === undefined) throw new Error(`ENOENT ${path}`);
		return { uid: 0, mode: node.link ? 0o777 : 0o755, ...node };
	};
	return {
		lstat: (path) => {
			const node = at(path);
			return {
				uid: node.uid,
				mode: node.mode,
				isSymbolicLink: () => node.link !== undefined,
			};
		},
		readlink: (path) => at(path).link ?? "",
		runnable: (path) => path in nodes && nodes[path]?.link === undefined,
	};
}

/** NixOS's way to a program: the profile's links into the store. */
const NIXOS: Record<string, Partial<Node>> = {
	"/": {},
	"/etc": {},
	"/etc/profiles": {},
	"/etc/profiles/per-user": {},
	"/etc/profiles/per-user/joel": { link: "/etc/static/profiles/per-user/joel" },
	"/etc/static": { link: "/nix/store/aaa-etc/etc" },
	"/nix": {},
	"/nix/store": { mode: 0o1775 },
	"/nix/store/aaa-etc": { mode: 0o555 },
	"/nix/store/aaa-etc/etc": { mode: 0o555 },
	"/nix/store/aaa-etc/etc/profiles": { mode: 0o555 },
	"/nix/store/aaa-etc/etc/profiles/per-user": { mode: 0o555 },
	"/nix/store/aaa-etc/etc/profiles/per-user/joel": {
		link: "/nix/store/bbb-user-environment",
	},
	"/nix/store/bbb-user-environment": { mode: 0o555 },
	"/nix/store/bbb-user-environment/bin": { mode: 0o555 },
	"/nix/store/bbb-user-environment/bin/bwrap": {
		link: "../../ccc-bubblewrap/bin/bwrap",
	},
	"/nix/store/ccc-bubblewrap": { mode: 0o555 },
	"/nix/store/ccc-bubblewrap/bin": { mode: 0o555 },
	"/nix/store/ccc-bubblewrap/bin/bwrap": { mode: 0o555 },
};
const PROFILE = ["/etc/profiles/per-user/joel/bin"];

describe("a program that runs outside the sandbox", () => {
	it("is found through the system profile's links, at its own path in the store", () => {
		expect(systemProgram("bwrap", PROFILE, disk(NIXOS))).toBe(
			"/nix/store/ccc-bubblewrap/bin/bwrap",
		);
	});

	it("is refused where a step is the user's, or writable by others", () => {
		const theirs = disk({
			...NIXOS,
			"/etc/profiles/per-user": { uid: 1000 },
		});
		const open = disk({ ...NIXOS, "/etc/profiles": { mode: 0o775 } });
		const loose = disk({
			...NIXOS,
			"/nix/store/ccc-bubblewrap/bin/bwrap": { mode: 0o757 },
		});

		expect(systemProgram("bwrap", PROFILE, theirs)).toBeUndefined();
		expect(systemProgram("bwrap", PROFILE, open)).toBeUndefined();
		expect(systemProgram("bwrap", PROFILE, loose)).toBeUndefined();
	});

	it("is refused where a link of root's leads through a folder of the user's", () => {
		const astray = disk({
			...NIXOS,
			"/nix/store/bbb-user-environment/bin/bwrap": {
				link: "/home/joel/.direnv/bin/bwrap",
			},
			"/home": {},
			"/home/joel": { uid: 1000 },
			"/home/joel/.direnv": { uid: 1000 },
			"/home/joel/.direnv/bin": { uid: 1000 },
			"/home/joel/.direnv/bin/bwrap": { uid: 1000 },
		});

		expect(systemProgram("bwrap", PROFILE, astray)).toBeUndefined();
	});

	it("takes no folder but those it is given, and no name holding a slash", () => {
		expect(
			systemProgram("bwrap", ["/home/joel/bin"], disk(NIXOS)),
		).toBeUndefined();
		expect(
			systemProgram("../ccc-bubblewrap/bin/bwrap", PROFILE, disk(NIXOS)),
		).toBeUndefined();
	});

	it("follows no endless loop of links", () => {
		const loop = disk({ "/": {}, "/a": { link: "/b" }, "/b": { link: "/a" } });

		expect(sealedPath("/a", loop)).toBeUndefined();
	});

	it("follows as many links as the system does, and no more", () => {
		// A chain of `links` links, /l1 to /l2 and on, the last to /made.
		const chain = (links: number): Look => {
			const nodes: Record<string, Partial<Node>> = { "/": {}, "/made": {} };
			for (let link = 1; link <= links; link++)
				nodes[`/l${link}`] = {
					link: link === links ? "/made" : `/l${link + 1}`,
				};
			return disk(nodes);
		};

		expect(sealedPath("/l1", chain(MOST_LINKS))).toBe("/made");
		expect(sealedPath("/l1", chain(MOST_LINKS + 1))).toBeUndefined();
		// Each count a system holds a walk to, whichever this one is, and
		// whichever system holds it, which the case below pins.
		for (const most of [40, 32, 20]) {
			expect(sealedPath("/l1", chain(most), most), `${most}`).toBe("/made");
			expect(
				sealedPath("/l1", chain(most + 1), most),
				`${most}`,
			).toBeUndefined();
		}
	});

	it("counts links as each system does, and a system it doesn't name as 32", () => {
		const counts: [NodeJS.Platform, number][] = [
			["linux", 40],
			["android", 40],
			["sunos", 20],
			["darwin", 32],
			["freebsd", 32],
			["openbsd", 32],
			// Named nowhere in the count's doc, so held to 32 as it says,
			// whatever the system's own count: these aren't checked counts.
			["aix", 32],
			["win32", 32],
		];
		for (const [platform, most] of counts)
			expect(mostLinksOn(platform), platform).toBe(most);
	});
});

describe("on this machine's own disk", () => {
	let planted: string;

	beforeAll(() => {
		planted = mkdtempSync(join(tmpdir(), "planted-"));
		for (const name of ["bwrap", "landrun", "nix-offload", "env"]) {
			const path = join(planted, name);
			writeFileSync(path, "#!/bin/sh\nexit 0\n");
			chmodSync(path, 0o755);
		}
	});

	afterAll(() => rmSync(planted, { recursive: true, force: true }));

	it("refuses a program planted in a folder of the user's", () => {
		expect(
			systemProgram("bwrap", [planted]),
			"a planted bwrap in a temporary folder was taken",
		).toBeUndefined();
	});

	it("gives the fence nothing planted earlier on PATH, so no command runs", () => {
		const sandbox = sandboxFor({ PI_SANDBOX: FENCE }, "linux", (name) =>
			systemProgram(name, [planted]),
		);

		expect(sandbox.kind).toBe("refused");
	});
});

describe("root inside a user namespace", () => {
	/** `/proc` as a process sees it with `map` as its uid_map. */
	const proc =
		(map: string) =>
		(path: string): string => {
			if (path === "/proc/self/uid_map") return map;
			if (path === "/proc/sys/kernel/overflowuid") return "65534\n";
			throw new Error(`ENOENT ${path}`);
		};

	const machines = "         0          0 4294967295\n";

	it("is root alone where the namespace is the machine's", () => {
		expect(rootOwners(proc(machines), 1000), "as the person").toEqual([0]);
		expect(rootOwners(proc(machines), 0), "as root").toEqual([0]);
	});

	it("is the overflow user where it maps only the person, as the fence's", () => {
		// The inner 0 beside it is unmapped there, so no file shows as it.
		expect(
			rootOwners(proc("      1000       1000          1\n"), 1000),
			"the fence's namespace",
		).toEqual([65534, 0]);
	});

	it("never counts the person mapped as inner root, as `unshare -r` does", () => {
		expect(
			rootOwners(proc("         0       1000          1\n"), 0),
			"the person as inner root",
		).toEqual([65534]);
	});

	it("never counts the person as root under a nested `unshare -r`", () => {
		// The map names the namespace above's ids, where the person is 0.
		expect(
			rootOwners(proc("         0          0          1\n"), 0),
			"the person as root a level up",
		).toEqual([65534]);
	});

	it("counts an unprivileged container's own root, whom pi isn't", () => {
		expect(
			rootOwners(proc("         0     100000      65536\n"), 1000),
			"the container's own root",
		).toEqual([65534, 0]);
	});

	it("counts a toolbox's own root, not the person its map names as the root above", () => {
		const toolbox =
			"         0          1       1000\n      1000          0          1\n      1001       1001      64536\n";

		expect(rootOwners(proc(toolbox), 1000), "the toolbox's own root").toEqual([
			65534, 0,
		]);
	});

	it("is the inner id the outer root maps to, wherever that is", () => {
		expect(
			rootOwners(
				proc(
					"         0       1000          1\n      5000          0          1\n",
				),
				1000,
			),
			"the outer root's inner id",
		).toEqual([5000]);
	});

	it.each([
		["can't be read", undefined],
		["reads empty", "\n"],
	])(
		"never counts the person as root where the overflow user %s",
		(_, said) => {
			const read =
				(map: string) =>
				(path: string): string => {
					if (path === "/proc/self/uid_map") return map;
					if (said !== undefined && path === "/proc/sys/kernel/overflowuid") {
						return said;
					}
					throw new Error(`EACCES ${path}`);
				};

			expect(
				rootOwners(read("         0       1000          1\n"), 0),
				"the person as inner root",
			).toEqual([]);
			expect(
				rootOwners(read("      1000       1000          1\n"), 1000),
				"the inner 0 this process isn't, where root is unmapped",
			).toEqual([0]);
		},
	);

	it("never counts this process's own files where it is the overflow user", () => {
		// `unshare -U` with no map written: every file, the person's too,
		// shows as the overflow user, and so does this process.
		expect(rootOwners(proc(""), 65534), "a namespace that maps nobody").toEqual(
			[0],
		);
	});

	it("keeps no overflow user an inner root can give its files to", () => {
		// A rootless container's root maps 65536 ids, 65534 among them, and
		// can chown a file to any of them.
		expect(
			rootOwners(proc("         0       1000      65536\n"), 0),
			"the overflow id mapped",
		).toEqual([]);
		expect(
			rootOwners(proc("         0       1000          1\n"), 0),
			"the overflow id left out",
		).toEqual([65534]);
		// Read on every line, its range's last id in and the one past out.
		expect(
			rootOwners(
				proc(
					"         0       1000          1\n         1     100000      65534\n",
				),
				0,
			),
			"the overflow id last in a later line's range",
		).toEqual([]);
		// A rootless toolbox entered as its root: the person is inner 0 and
		// the subordinate ids cover the overflow id.
		expect(
			rootOwners(
				proc(
					"         0       1000          1\n         1     100000      65536\n",
				),
				0,
			),
			"a rootless toolbox, as its root",
		).toEqual([]);
		expect(
			rootOwners(
				proc(
					"         0       1000          1\n         1     100000      65533\n",
				),
				0,
			),
			"the overflow id just past a later line's range",
		).toEqual([65534]);
	});

	it("keeps no outer root an inner root can give its files to", () => {
		// Inner 0 can chown a file to any id the map names, the outer
		// root's among them, so a planted program would pass as root's.
		expect(
			rootOwners(
				proc(
					"         0       1000          1\n      5000          0          1\n",
				),
				0,
			),
			"the outer root mapped beside this process as inner 0",
		).toEqual([]);
	});

	it("is root alone where there is no /proc, as on a Mac", () => {
		const none = (): string => {
			throw new Error("ENOENT");
		};

		expect(rootOwners(none, 1000, "darwin"), "a Mac, as the person").toEqual([
			0,
		]);
		expect(rootOwners(none, 0, "darwin"), "a Mac, as root").toEqual([0]);
		expect(rootOwners(none, 1000, "linux"), "a Linux, as the person").toEqual([
			0,
		]);
	});

	it("never counts this process as root on a Linux whose /proc can't be read", () => {
		// Under `unshare -r` with no `/proc` mounted, 0 is the person.
		expect(
			rootOwners(
				() => {
					throw new Error("ENOENT");
				},
				0,
				"linux",
			),
			"0 with no map to read",
		).toEqual([]);
	});

	it("takes a program the overflow user holds only where it stands for root", () => {
		const overflowed: Record<string, Partial<Node>> = Object.fromEntries(
			Object.entries(NIXOS).map(([path, node]) => [
				path,
				{ ...node, uid: 65534 },
			]),
		);
		const seen = (owners: readonly number[]): Look => ({
			...disk(overflowed),
			rootOwners: () => owners,
		});

		expect(
			systemProgram("bwrap", PROFILE, seen([0])),
			"the overflow user, standing for no root",
		).toBeUndefined();
		expect(
			systemProgram("bwrap", PROFILE, seen([0, 65534])),
			"the overflow user, standing for root",
		).toBeDefined();
		// On root's own disk, so an empty list read as root's would find it.
		const rooted = (owners: readonly number[]): Look => ({
			...disk(NIXOS),
			rootOwners: () => owners,
		});
		expect(
			systemProgram("bwrap", PROFILE, rooted([0])),
			"root trusted, on root's disk",
		).toBeDefined();
		expect(
			systemProgram("bwrap", PROFILE, rooted([])),
			"no owner trusted at all",
		).toBeUndefined();
	});

	it("says when no owner is trusted, so a caller can say why nothing was found", () => {
		const owning = (owners: readonly number[]): Look => ({
			...disk(NIXOS),
			rootOwners: () => owners,
		});

		expect(trustsNoOwner(owning([])), "no owner").toBe(true);
		expect(trustsNoOwner(owning([65534])), "the overflow user").toBe(false);
		expect(trustsNoOwner(disk(NIXOS)), "root, where none says").toBe(false);
	});

	it("trusts no owner only where this process is 0, so running as another id always helps", () => {
		// Every map a case here reads, and none at all.
		const maps = [
			"         0          0 4294967295\n",
			"         0       1000          1\n",
			"      1000       1000          1\n",
			"         0       1000      65536\n",
			"         0       1000          1\n      5000          0          1\n",
			"         0       1000          1\n         1     100000      65536\n",
			"",
		];
		const reads = [
			...maps.map(proc),
			(): string => {
				throw new Error("ENOENT");
			},
		];
		for (const read of reads) {
			for (const uid of [1, 1000, 5000, 65534, 100000]) {
				expect(
					rootOwners(read, uid, "linux").length,
					`as ${uid}, no owner trusted`,
				).toBeGreaterThan(0);
			}
		}
	});

	it("says why no owner is trusted: a namespace, or a map it can't read", () => {
		const none = (readsMap: boolean): Look => ({
			...disk(NIXOS),
			rootOwners: () => [],
			readsMap: () => readsMap,
		});

		expect(noOwner(disk(NIXOS)), "root trusted").toBeUndefined();
		expect(noOwner(none(true)), "a map read").toBe("namespace");
		expect(noOwner(none(false)), "no map read").toBe("unread");
		expect(
			noOwner({ ...disk(NIXOS), rootOwners: () => [] }),
			"a look that doesn't say",
		).toBe("namespace");
	});

	it("refuses by the folders where an owner is trusted, and by the namespace where none is", () => {
		expect(notKept(["landrun"], undefined), "an owner trusted").toEqual({
			because:
				"landrun isn't in the system's own profile, where only root puts programs",
		});
		expect(
			notKept(["bwrap", "landrun"], undefined).because,
			"two names, an owner trusted",
		).toBe(
			"bwrap and landrun aren't in the system's own profile, where only root puts programs",
		);
		expect(notKept(["bwrap"], "namespace"), "in a namespace").toEqual({
			because:
				"bwrap can't be trusted: no owner here can be told from pi's own, as in a " +
				"user namespace whose ids pi can give its files to",
			fix: "Run pi as an id other than 0 there.",
		});
		expect(notKept(["bwrap"], "unread"), "no map").toEqual({
			because:
				"bwrap can't be trusted: no owner here can be told from pi's own, since " +
				"/proc can't be read to say which user namespace pi is in",
			fix: "Mount /proc, or run pi as an id other than 0.",
		});
	});
});
