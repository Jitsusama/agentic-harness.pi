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
	rootOwners,
	sealedPath,
	systemProgram,
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
		// Each system's count, whichever this one is.
		for (const platform of ["linux", "darwin", "sunos"] as const) {
			const most = mostLinksOn(platform);
			expect(sealedPath("/l1", chain(most), most), platform).toBe("/made");
			expect(
				sealedPath("/l1", chain(most + 1), most),
				platform,
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
			// Named nowhere in the count's doc.
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

	it("is root alone where the namespace maps root", () => {
		expect(rootOwners(proc("         0          0 4294967295\n"))).toEqual([0]);
	});

	it("is the overflow user alone where it maps only the person, as the fence's", () => {
		expect(rootOwners(proc("      1000       1000          1\n"))).toEqual([
			65534,
		]);
	});

	it("never counts the person mapped as inner root, as `unshare -r` does", () => {
		expect(rootOwners(proc("         0       1000          1\n"))).toEqual([
			65534,
		]);
	});

	it("is the inner id the outer root maps to, wherever that is", () => {
		expect(
			rootOwners(
				proc(
					"         0       1000          1\n      5000          0          1\n",
				),
			),
		).toEqual([5000]);
	});

	it("is root alone where there is no /proc, as on a Mac", () => {
		expect(
			rootOwners(() => {
				throw new Error("ENOENT");
			}),
		).toEqual([0]);
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

		expect(systemProgram("bwrap", PROFILE, seen([0]))).toBeUndefined();
		expect(systemProgram("bwrap", PROFILE, seen([0, 65534]))).toBeDefined();
	});
});
