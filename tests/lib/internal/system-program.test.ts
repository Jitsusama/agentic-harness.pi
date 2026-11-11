/**
 * Programs that run outside a sandbox come only from folders root alone
 * writes: a fenced command can plant one earlier on PATH, or add one to
 * the Nix store as an untrusted client, and neither may be taken.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FENCE } from "../../../lib/internal/fence.ts";
import { sandboxFor } from "../../../lib/internal/sandbox.ts";
import {
	type Look,
	sealedPath,
	systemProgram,
} from "../../../lib/internal/system-program.ts";

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
