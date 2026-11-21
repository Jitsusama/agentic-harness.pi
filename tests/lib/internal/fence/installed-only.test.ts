/**
 * Whether a fenced session's children may start: only while this
 * package, and for an unisolated child the harness the person's settings
 * name, lie in pi's installed packages, where no fenced command writes.
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fencedChildrenRefusal,
	inside,
	installedPackages,
	packageRoot,
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

describe("where pi's packages are installed", () => {
	it("is the folder they lie in, followed", () => {
		const elsewhere = join(home, "store");
		mkdirSync(elsewhere);
		rmSync(packages, { recursive: true });
		symlinkSync(elsewhere, packages);
		expect(installedPackages(home)).toBe(elsewhere);
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
	const named = (path: string | undefined) => () => path;

	it("start from a session running the installed package", () => {
		expect(
			fencedChildrenRefusal(false, packages, installed, named(undefined)),
		).toBeUndefined();
	});

	it("don't start from a session running this package from a tree, which its fenced commands may write", () => {
		const refusal = fencedChildrenRefusal(
			false,
			packages,
			tree,
			named(installed),
		);
		expect(refusal).toContain(`runs the harness from ${tree}`);
		expect(refusal).toContain('reload with onto "installed"');
	});

	it("don't start where pi has installed no packages", () => {
		expect(
			fencedChildrenRefusal(false, null, installed, named(installed)),
		).toContain("outside pi's installed packages");
	});

	it("start unisolated while the person's settings load the installed harness", () => {
		expect(
			fencedChildrenRefusal(true, packages, installed, named(installed)),
		).toBeUndefined();
	});

	it("don't start unisolated while the person's settings load the harness from a tree", () => {
		expect(
			fencedChildrenRefusal(true, packages, installed, named(tree)),
		).toContain(`which name ${tree}, outside pi's installed packages`);
	});

	it("don't start unisolated while the person's settings load no harness, whose fenced bash they would lack", () => {
		expect(
			fencedChildrenRefusal(true, packages, installed, named(undefined)),
		).toContain("which name none");
	});

	it("start isolated whatever the person's settings load, since an isolated child loads none of them", () => {
		expect(
			fencedChildrenRefusal(false, packages, installed, named(tree)),
		).toBeUndefined();
	});
});
