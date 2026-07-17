import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getParentPiInstall,
	resolveParentPiInstall,
} from "../../../lib/subagent/install";

const STARTUP_INSTALL_KEY = Symbol.for("pi.subagent.startupPiInstall");
function clearStartupSnapshot(): void {
	delete (globalThis as Record<symbol, unknown>)[STARTUP_INSTALL_KEY];
}

// A running pi is reached through profile symlinks that a
// package upgrade can repoint mid-session. Spawning a child
// as bare `pi` therefore resolves to whatever the new
// symlink points at, not the install the parent is running.
// resolveParentPiInstall pins the child to the parent's
// exact install by dereferencing the node binary and the
// entry script the parent booted from.

describe("resolveParentPiInstall", () => {
	it("dereferences the node binary and entry script to their real paths", () => {
		const install = resolveParentPiInstall({
			execPath: "/profile/bin/node",
			argv: ["/profile/bin/node", "/profile/lib/cli.js", "--mode", "json"],
			piPackageDir: undefined,
			realpath: (p) =>
				p === "/profile/bin/node"
					? "/nix/store/node-22/bin/node"
					: p === "/profile/lib/cli.js"
						? "/nix/store/pi-0.80.2/dist/cli.js"
						: p,
		});
		expect(install.node).toBe("/nix/store/node-22/bin/node");
		expect(install.entry).toBe("/nix/store/pi-0.80.2/dist/cli.js");
	});

	it("falls back to the raw path when a target cannot be dereferenced", () => {
		const install = resolveParentPiInstall({
			execPath: "/gone/bin/node",
			argv: ["/gone/bin/node", "/gone/dist/cli.js"],
			piPackageDir: undefined,
			realpath: () => {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			},
		});
		expect(install.node).toBe("/gone/bin/node");
		expect(install.entry).toBe("/gone/dist/cli.js");
	});

	// Pi resolves its bundled assets (the theme it loads at
	// startup) through PI_PACKAGE_DIR, which launchers point at
	// a versioned symlink an upgrade deletes. Dereferencing it
	// to the immutable store target at capture time pins the
	// child's assets to the parent's exact install.
	it("dereferences PI_PACKAGE_DIR to its immutable target", () => {
		const install = resolveParentPiInstall({
			execPath: "/profile/bin/node",
			argv: ["/profile/bin/node", "/profile/lib/cli.js"],
			piPackageDir: "/home/x/.pi/pkg/pi-0.80.7",
			realpath: (p) =>
				p === "/home/x/.pi/pkg/pi-0.80.7"
					? "/nix/store/pi-0.80.7/lib/node_modules/pi-monorepo"
					: p,
		});
		expect(install.packageDir).toBe(
			"/nix/store/pi-0.80.7/lib/node_modules/pi-monorepo",
		);
	});

	it("omits packageDir when the parent has no PI_PACKAGE_DIR", () => {
		const install = resolveParentPiInstall({
			execPath: "/usr/bin/node",
			argv: ["/usr/bin/node", "/usr/lib/pi/cli.js"],
			piPackageDir: undefined,
			realpath: (p) => p,
		});
		expect(install.packageDir).toBeUndefined();
	});

	it("keeps the raw PI_PACKAGE_DIR when it cannot be dereferenced", () => {
		const install = resolveParentPiInstall({
			execPath: "/usr/bin/node",
			argv: ["/usr/bin/node", "/usr/lib/pi/cli.js"],
			piPackageDir: "/home/x/.pi/pkg/pi-0.80.7",
			realpath: (p) => {
				if (p === "/home/x/.pi/pkg/pi-0.80.7") {
					throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				}
				return p;
			},
		});
		expect(install.packageDir).toBe("/home/x/.pi/pkg/pi-0.80.7");
	});
});

// The startup accessor is what production spawns and the health
// check use. It must capture the install once, before a
// mid-session upgrade can delete the versioned symlink, and hand
// that same reading to every later caller — including after a
// /reload, which pi runs with jiti's module cache off, so a
// module-level constant would recompute against the mutated,
// post-upgrade environment.
describe("getParentPiInstall", () => {
	beforeEach(() => clearStartupSnapshot());

	it("captures once and ignores later environment changes", () => {
		const previous = process.env.PI_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = "/tmp/pi-pkg-at-startup";
		try {
			const first = getParentPiInstall();
			// A mid-session upgrade mutates the environment and, in
			// reality, deletes the old symlink. The accessor must keep
			// the pre-upgrade reading rather than re-probe.
			process.env.PI_PACKAGE_DIR = "/tmp/pi-pkg-after-upgrade-deleted";
			expect(getParentPiInstall()).toBe(first);
			expect(first.packageDir).toBe("/tmp/pi-pkg-at-startup");
		} finally {
			if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = previous;
		}
	});

	it("survives a reload: a fresh module instance reuses the first snapshot", async () => {
		const previous = process.env.PI_PACKAGE_DIR;
		process.env.PI_PACKAGE_DIR = "/tmp/pi-pkg-reload-startup";
		try {
			const first = getParentPiInstall();
			// Simulate pi's /reload: re-evaluate the module (jiti runs
			// with moduleCache off) against a mutated environment. The
			// globalThis stash must win over the fresh module's probe.
			vi.resetModules();
			process.env.PI_PACKAGE_DIR = "/tmp/pi-pkg-reload-after-upgrade";
			const { getParentPiInstall: reloaded } = await import(
				"../../../lib/subagent/install"
			);
			expect(reloaded().packageDir).toBe("/tmp/pi-pkg-reload-startup");
			expect(reloaded()).toEqual(first);
		} finally {
			if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = previous;
		}
	});
});
