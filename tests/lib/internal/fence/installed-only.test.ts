/**
 * Whether a fenced session's children may start: only while this
 * package, every extension registered as their default and, for an
 * unisolated child, everything the person's settings load lie in pi's
 * installed packages, where no fenced command writes.
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fencedChildrenRefusal,
	inside,
	installedPackages,
	type Places,
	packageRoot,
	settingsRefusal,
} from "../../../../lib/internal/fence/installed-only.ts";

let home: string;
let packages: string;
let installed: string;
let tree: string;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "installed-only-")));
	packages = join(home, ".local", "share", "pi-packages");
	installed = join(packages, "harness", "versions", "a");
	tree = join(home, "src", "harness");
	mkdirSync(installed, { recursive: true });
	mkdirSync(tree, { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** A file at `path`, its folders made, returned. */
function planted(path: string): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "");
	return path;
}

/** The places the gate reads, the person's settings naming `harness`. */
function places(
	own: string,
	harness: string | undefined = undefined,
	root: string | null = packages,
): Places {
	return { root, own, harness: () => harness };
}

describe("where pi's packages are installed", () => {
	it("is the folder under the home folder they lie in", () => {
		expect(installedPackages(home)).toBe(packages);
	});

	it("is nothing where the folder links elsewhere, since the fence holds it read-only by its name", () => {
		const elsewhere = join(home, "store");
		mkdirSync(elsewhere);
		rmSync(packages, { recursive: true });
		symlinkSync(elsewhere, packages);
		expect(installedPackages(home)).toBeNull();
	});

	it("is nothing where pi has installed none", () => {
		rmSync(packages, { recursive: true });
		expect(installedPackages(home)).toBeNull();
	});
});

describe("a path inside the install", () => {
	it("is the install or below it, never a folder whose name only starts the same", () => {
		expect(inside(packages, packages)).toBe(true);
		expect(inside(installed, packages)).toBe(true);
		expect(inside(`${packages}-planted`, packages)).toBe(false);
		expect(inside(installed, null)).toBe(false);
	});
});

describe("this package's own folder", () => {
	it("is the one holding its package.json", () => {
		expect(packageRoot()).toBe(
			realpathSync(join(import.meta.dirname, "..", "..", "..", "..")),
		);
	});
});

describe("a fenced session's children", () => {
	it("start from a session running the installed package", () => {
		expect(fencedChildrenRefusal(false, [], places(installed))).toBeUndefined();
	});

	it("don't start from a session running this package from a tree, which its fenced commands may write", () => {
		const refusal = fencedChildrenRefusal(false, [], places(tree, installed));
		expect(refusal).toContain(`runs the harness from ${tree}`);
		expect(refusal).toContain('reload with onto "installed"');
	});

	it("don't start where pi has installed no packages", () => {
		expect(
			fencedChildrenRefusal(false, [], places(installed, installed, null)),
		).toContain("outside pi's installed packages (~/.local/share/pi-packages)");
	});

	it("start while every extension registered as their default is installed", () => {
		const pack = planted(join(packages, "mesh", "current", "index.ts"));
		expect(
			fencedChildrenRefusal(false, [pack], places(installed)),
		).toBeUndefined();
	});

	it("don't start while an extension registered as their default lies in a tree", () => {
		const stray = planted(join(tree, "extensions", "mesh", "index.ts"));
		expect(fencedChildrenRefusal(false, [stray], places(installed))).toContain(
			`registered for every subagent lies outside pi's installed packages (~/.local/share/pi-packages), where fenced commands may write, and each child would load it outside the fence: ${stray}`,
		);
	});

	it("don't start while a default links from the install into a tree", () => {
		const stray = planted(join(tree, "index.ts"));
		const link = join(packages, "mesh.ts");
		symlinkSync(stray, link);
		expect(fencedChildrenRefusal(false, [link], places(installed))).toContain(
			link,
		);
	});

	it("don't start while a default isn't there to follow", () => {
		const gone = join(packages, "gone", "index.ts");
		expect(fencedChildrenRefusal(false, [gone], places(installed))).toContain(
			gone,
		);
	});

	it("start unisolated while the person's settings load the installed harness", () => {
		expect(
			fencedChildrenRefusal(true, [], places(installed, installed)),
		).toBeUndefined();
	});

	it("don't start unisolated while the person's settings load the harness from a tree", () => {
		expect(fencedChildrenRefusal(true, [], places(installed, tree))).toContain(
			`which name ${tree}, outside pi's installed packages`,
		);
	});

	it("don't start unisolated while the person's settings load no harness, whose fenced bash they would lack", () => {
		expect(fencedChildrenRefusal(true, [], places(installed))).toContain(
			"which name none",
		);
	});

	it("start isolated whatever the person's settings load, since an isolated child loads none of them", () => {
		expect(
			fencedChildrenRefusal(false, [], places(installed, tree)),
		).toBeUndefined();
	});
});

describe("what the person's settings load into an unisolated child", () => {
	it("passes while every extension they name is installed", async () => {
		const pack = planted(join(packages, "web", "current", "index.ts"));
		expect(await settingsRefusal(packages, async () => [pack])).toBeUndefined();
	});

	it("is refused while one lies in a tree, naming it", async () => {
		const pack = planted(join(packages, "web", "current", "index.ts"));
		const stray = planted(join(tree, "extensions", "web.ts"));
		const refusal = await settingsRefusal(packages, async () => [pack, stray]);
		expect(refusal).toContain(`outside pi's installed packages`);
		expect(refusal).toContain(stray);
		expect(refusal).not.toContain(pack);
	});

	it("is refused where pi has installed no packages", async () => {
		const pack = planted(join(tree, "index.ts"));
		expect(await settingsRefusal(null, async () => [pack])).toContain(pack);
	});

	it("is refused, not passed, when the settings can't be read", async () => {
		expect(
			await settingsRefusal(packages, async () => {
				throw new Error("no settings");
			}),
		).toContain("couldn't be read (no settings)");
	});
});
