import { describe, expect, it } from "vitest";
import { resolveParentPiInstall } from "../../../lib/subagent/install";

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
