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
	heldElsewhere,
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
	held: readonly string[] = [],
	store: string = join(home, "store"),
): Places {
	return { root, own, harness: () => harness, held, store };
}

/** The fence's bash, as the installed harness holds it. */
function fencedBash(): string {
	return planted(join(installed, "extensions", "shell-workflow", "index.ts"));
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

describe("the other places no fenced command writes", () => {
	it("are pi's agent folder and the Nix store", () => {
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		expect(heldElsewhere(home)).toEqual([
			join(home, ".pi", "agent"),
			"/nix/store",
		]);
	});

	it("leave out an agent folder that links elsewhere, since the fence holds it by its name", () => {
		const elsewhere = join(home, "elsewhere");
		mkdirSync(elsewhere);
		mkdirSync(join(home, ".pi"));
		symlinkSync(elsewhere, join(home, ".pi", "agent"));
		expect(heldElsewhere(home)).toEqual(["/nix/store"]);
	});
});

describe("a path inside the install", () => {
	it("is the install or below it, never a folder whose name only starts the same", () => {
		expect(inside(packages, packages), "the install is inside itself").toBe(
			true,
		);
		expect(
			inside(installed, packages),
			"a folder below the install is inside it",
		).toBe(true);
		expect(
			inside(`${packages}-planted`, packages),
			"a folder whose name only starts the install's is not inside it",
		).toBe(false);
		expect(inside(installed, null), "nothing is inside no install").toBe(false);
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

	it("start from a session running the harness from the Nix store, as a room runs it with no install", () => {
		const store = join(home, "store");
		const harness = join(store, "abc-harness");
		mkdirSync(harness, { recursive: true });
		expect(
			fencedChildrenRefusal(
				false,
				[],
				places(harness, undefined, null, [store], store),
			),
		).toBeUndefined();
	});

	it("don't start from a tree, or from pi's agent folder, though both the store and that folder hold defaults", () => {
		const store = join(home, "store");
		const agent = join(home, ".pi", "agent");
		const fromAgent = join(agent, "harness");
		mkdirSync(fromAgent, { recursive: true });
		for (const own of [tree, fromAgent]) {
			expect(
				fencedChildrenRefusal(
					false,
					[],
					places(own, installed, packages, [agent, store], store),
				),
			).toContain(`runs the harness from ${own}`);
		}
	});

	it("don't start unisolated while the person's settings load the harness from the store, which only the install answers for", () => {
		const store = join(home, "store");
		const harness = join(store, "abc-harness");
		mkdirSync(harness, { recursive: true });
		expect(
			fencedChildrenRefusal(
				true,
				[],
				places(harness, harness, null, [store], store),
			),
		).toContain(`which name ${harness}`);
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
			`registered for every subagent lies where fenced commands may write, outside pi's installed packages (~/.local/share/pi-packages), pi's agent folder and the Nix store, and each child would load it outside the fence: ${stray}`,
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

	it("start while a default lies in a held place, as pi's agent folder is", () => {
		const agent = join(home, ".pi", "agent");
		const pack = planted(join(agent, "extensions", "proxy", "index.ts"));
		expect(
			fencedChildrenRefusal(
				false,
				[pack],
				places(installed, undefined, packages, [agent]),
			),
		).toBeUndefined();
	});

	it("don't start while a default is named by a link in a tree, which a fenced command could swap after the check", () => {
		const pack = planted(join(packages, "mesh", "index.ts"));
		const link = join(tree, "mesh");
		symlinkSync(join(packages, "mesh"), link);
		const named = join(link, "index.ts");
		expect(pack).not.toBe(named);
		expect(fencedChildrenRefusal(false, [named], places(installed))).toContain(
			named,
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
	it("passes while every extension they name is installed, the fence's bash among them", async () => {
		const pack = planted(join(packages, "web", "current", "index.ts"));
		expect(
			await settingsRefusal(packages, async () => [fencedBash(), pack], []),
		).toBeUndefined();
	});

	it("passes an extension pi finds in its agent folder, which the fence holds read-only", async () => {
		const agent = join(home, ".pi", "agent");
		const found = planted(join(agent, "extensions", "gateway", "index.ts"));
		expect(
			await settingsRefusal(packages, async () => [fencedBash(), found], [
				agent,
			]),
		).toBeUndefined();
	});

	it("is refused while one lies in a tree, naming it", async () => {
		const pack = planted(join(packages, "web", "current", "index.ts"));
		const stray = planted(join(tree, "extensions", "web.ts"));
		const refusal = await settingsRefusal(
			packages,
			async () => [fencedBash(), pack, stray],
			[],
		);
		expect(refusal).toContain("where fenced commands may write");
		expect(refusal).toContain(stray);
		expect(refusal).not.toContain(pack);
	});

	it("is refused while none of them is the fence's bash from the install, which a package filter could leave out", async () => {
		const pack = planted(join(packages, "web", "current", "index.ts"));
		const bash = planted(
			join(home, ".pi", "agent", "extensions", "shell-workflow", "index.ts"),
		);
		expect(
			await settingsRefusal(packages, async () => [pack, bash], [
				join(home, ".pi", "agent"),
			]),
		).toContain("load no fence's bash");
	});

	it("is refused where pi has installed no packages", async () => {
		const pack = planted(join(tree, "index.ts"));
		expect(await settingsRefusal(null, async () => [pack], [])).toContain(pack);
	});

	it("is refused, not passed, when the settings can't be read", async () => {
		expect(
			await settingsRefusal(packages, async () => {
				throw new Error("no settings");
			}, []),
		).toContain("couldn't be read (no settings)");
	});
});
