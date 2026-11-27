import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installHost, withSession } from "../../../lib/core/session/index.ts";
import {
	getParentPiInstall,
	resolveParentPiInstall,
} from "../../../lib/subagent/install.ts";
import { sessionHost } from "../../support/session-host.ts";

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

	// Shopify's pi wrapper deletes ~/.pi/pkg/pi-<version> on an upgrade,
	// while every pi started through it still names that link. The wrapper
	// starts node on the entry script's store path, inside the very package
	// the link named, so that script outlives the link.
	it("finds the package from the entry script when PI_PACKAGE_DIR is gone", () => {
		const entry = "/nix/store/pi-0.80.7/pi-monorepo/dist/bundle/cli.js";
		const install = resolveParentPiInstall({
			execPath: "/usr/bin/node",
			argv: ["/usr/bin/node", entry],
			piPackageDir: "/home/x/.pi/pkg/pi-0.80.7",
			realpath: (p) => {
				if (p === entry || p === "/usr/bin/node") return p;
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			},
			holdsPackage: (dir) => dir === "/nix/store/pi-0.80.7/pi-monorepo",
		});
		expect(install.packageDir).toBe("/nix/store/pi-0.80.7/pi-monorepo");
	});

	// A package found above a script that is itself gone would be some
	// other package, so nothing is looked for from a gone entry.
	it("looks for no package above an entry script that is gone", () => {
		const install = resolveParentPiInstall({
			execPath: "/usr/bin/node",
			argv: ["/usr/bin/node", "/gone/pi/dist/cli.js"],
			piPackageDir: "/home/x/.pi/pkg/pi-0.80.7",
			realpath: () => {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			},
			holdsPackage: () => true,
		});
		expect(install.entry).toBe("/gone/pi/dist/cli.js");
		expect(install.packageDir).toBe("/home/x/.pi/pkg/pi-0.80.7");
	});

	it("keeps the raw PI_PACKAGE_DIR when neither it nor the entry's package resolves", () => {
		const install = resolveParentPiInstall({
			execPath: "/usr/bin/node",
			argv: ["/usr/bin/node", "/usr/lib/pi/cli.js"],
			piPackageDir: "/home/x/.pi/pkg/pi-0.80.7",
			holdsPackage: () => false,
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
// that same reading to every later caller, including after a
// /reload, which pi runs with jiti's module cache off, so a
// module-level constant would recompute against the mutated,
// post-upgrade environment.
describe("getParentPiInstall", () => {
	beforeEach(() => clearStartupSnapshot());

	it("requires a real pi pin in a host and shares it across conversations", () => {
		const { host } = sessionHost({ pid: 123, startedAt: 1000 });
		const removeHost = installHost(host);
		try {
			expect(() => withSession("a", getParentPiInstall)).toThrow(
				"pin pi.subagent.startupPiInstall",
			);
			expect(() => withSession("b", getParentPiInstall)).toThrow(
				"pin pi.subagent.startupPiInstall",
			);
			const install = { node: "/node", entry: "/pi/cli.js", packageDir: "/pi" };
			(globalThis as Record<symbol, unknown>)[STARTUP_INSTALL_KEY] = install;
			expect(withSession("a", getParentPiInstall)).toBe(install);
			expect(withSession("b", getParentPiInstall)).toBe(install);
		} finally {
			removeHost();
			clearStartupSnapshot();
		}
	});

	// A pi that captured its install while the link was already gone, or
	// under code that kept the dead link, still holds that reading after a
	// reload; it heals from the entry, for its children and for pi itself.
	it("heals a snapshot whose package went, and says so in PI_PACKAGE_DIR", () => {
		const previous = process.env.PI_PACKAGE_DIR;
		const root = mkdtempSync(join(tmpdir(), "pi-pkg-"));
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "package.json"), "{}");
		writeFileSync(join(root, "dist", "cli.js"), "");
		const gone = join(root, "gone-link");
		process.env.PI_PACKAGE_DIR = gone;
		(globalThis as Record<symbol, unknown>)[STARTUP_INSTALL_KEY] = {
			node: process.execPath,
			entry: join(root, "dist", "cli.js"),
			packageDir: gone,
		};
		try {
			const healed = getParentPiInstall();
			expect(healed.packageDir).toBe(realpathSync(root));
			expect(process.env.PI_PACKAGE_DIR).toBe(realpathSync(root));
			expect(getParentPiInstall()).toBe(healed);
		} finally {
			if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = previous;
		}
	});

	it("heals no snapshot from an entry script that is gone too", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-pkg-")));
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "package.json"), "{}");
		const install = {
			node: process.execPath,
			entry: join(root, "dist", "gone-cli.js"),
			packageDir: join(root, "gone-link"),
		};
		(globalThis as Record<symbol, unknown>)[STARTUP_INSTALL_KEY] = install;
		expect(getParentPiInstall()).toBe(install);
	});

	// A first capture taken after the link went finds the package from
	// the entry, and pi itself must read its assets from there too.
	it("says a package found on a first capture in PI_PACKAGE_DIR", () => {
		const previous = process.env.PI_PACKAGE_DIR;
		const previousEntry = process.argv[1];
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-pkg-")));
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "package.json"), "{}");
		writeFileSync(join(root, "dist", "cli.js"), "");
		process.env.PI_PACKAGE_DIR = join(root, "gone-link");
		process.argv[1] = join(root, "dist", "cli.js");
		try {
			expect(getParentPiInstall().packageDir).toBe(root);
			expect(process.env.PI_PACKAGE_DIR).toBe(root);
		} finally {
			process.argv[1] = previousEntry ?? "";
			if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = previous;
		}
	});

	it("leaves PI_PACKAGE_DIR as named when its folder stands", () => {
		const previous = process.env.PI_PACKAGE_DIR;
		const target = realpathSync(mkdtempSync(join(tmpdir(), "pi-pkg-")));
		const link = join(mkdtempSync(join(tmpdir(), "pi-link-")), "pi-0.80.7");
		symlinkSync(target, link);
		process.env.PI_PACKAGE_DIR = link;
		try {
			expect(getParentPiInstall().packageDir).toBe(target);
			expect(process.env.PI_PACKAGE_DIR).toBe(link);
		} finally {
			if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = previous;
		}
	});

	// The entry sits in a package of its own, so a snapshot healed while
	// its package stands would move to that package and fail here.
	it("leaves a snapshot whose package stands as it is", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-pkg-")));
		const other = realpathSync(mkdtempSync(join(tmpdir(), "pi-other-")));
		mkdirSync(join(other, "dist"));
		writeFileSync(join(other, "package.json"), "{}");
		writeFileSync(join(other, "dist", "cli.js"), "");
		const install = {
			node: process.execPath,
			entry: join(other, "dist", "cli.js"),
			packageDir: root,
		};
		(globalThis as Record<symbol, unknown>)[STARTUP_INSTALL_KEY] = install;
		expect(getParentPiInstall()).toBe(install);
	});

	it("captures once and ignores later environment changes", () => {
		const previous = process.env.PI_PACKAGE_DIR;
		const atStartup = realpathSync(mkdtempSync(join(tmpdir(), "pi-pkg-")));
		process.env.PI_PACKAGE_DIR = atStartup;
		try {
			const first = getParentPiInstall();
			// A mid-session upgrade mutates the environment and, in
			// reality, deletes the old symlink. The accessor must keep
			// the pre-upgrade reading rather than re-probe.
			process.env.PI_PACKAGE_DIR = "/tmp/pi-pkg-after-upgrade-deleted";
			expect(getParentPiInstall()).toBe(first);
			expect(first.packageDir).toBe(atStartup);
		} finally {
			if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = previous;
		}
	});

	it("survives a reload: a fresh module instance reuses the first snapshot", async () => {
		const previous = process.env.PI_PACKAGE_DIR;
		const atStartup = realpathSync(mkdtempSync(join(tmpdir(), "pi-pkg-")));
		process.env.PI_PACKAGE_DIR = atStartup;
		try {
			const first = getParentPiInstall();
			// Simulate pi's /reload: re-evaluate the module (jiti runs
			// with moduleCache off) against a mutated environment. The
			// globalThis stash must win over the fresh module's probe.
			vi.resetModules();
			process.env.PI_PACKAGE_DIR = "/tmp/pi-pkg-reload-after-upgrade";
			const { getParentPiInstall: reloaded } = await import(
				"../../../lib/subagent/install.ts"
			);
			expect(reloaded().packageDir).toBe(atStartup);
			expect(reloaded()).toEqual(first);
		} finally {
			if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
			else process.env.PI_PACKAGE_DIR = previous;
		}
	});
});
