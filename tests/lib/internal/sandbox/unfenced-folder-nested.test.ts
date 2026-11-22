/**
 * Strict's walk for another repository below a working folder: a git
 * folder a command there could write, whose hooks git runs outside the
 * sandbox at the next git, found up to three levels down, hidden
 * folders included, and refused rather than granted where the folder
 * holds more than the walk can judge.
 */

import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	ASKED,
	NESTED_MOST,
	unfencedFolder,
} from "../../../../lib/internal/sandbox/unfenced-folder.ts";

let base: string;
let count = 0;

beforeAll(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "unfenced-nested-")));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A repository of its own in a home of its own, and where trees would be cut. */
function laid() {
	count += 1;
	const home = join(base, `home-${count}`);
	const repo = join(home, "src/github.com/org/repo");
	mkdirSync(join(repo, ".git"), { recursive: true });
	return { home, repo, place: { treesRoot: join(home, "trees"), mac: false } };
}

const another = (git: string) => `which holds ${git}, another repository's`;

it("finds another repository three levels down, and none four", () => {
	const { home, repo, place } = laid();
	mkdirSync(join(repo, "lib/a/b/c/.git"), { recursive: true });
	mkdirSync(join(repo, "deep/a/b/c/d/.git"), { recursive: true });

	expect(unfencedFolder(join(repo, "lib"), home, ASKED, place)).toContain(
		another(join(repo, "lib/a/b/c/.git")),
	);
	expect(
		unfencedFolder(join(repo, "deep"), home, ASKED, place),
	).toBeUndefined();
});

it("finds a bare repository below", () => {
	const { home, repo, place } = laid();
	const bare = join(repo, "vendor/dep.git");
	mkdirSync(join(bare, "objects"), { recursive: true });
	writeFileSync(join(bare, "HEAD"), "ref: refs/heads/main\n");

	expect(unfencedFolder(join(repo, "vendor"), home, ASKED, place)).toContain(
		another(bare),
	);
});

it("finds a clone a tool keeps in a hidden folder, as pip keeps an editable one", () => {
	const { home, repo, place } = laid();
	mkdirSync(join(repo, "py/.venv/src/pkg/.git/hooks"), { recursive: true });

	expect(unfencedFolder(join(repo, "py"), home, ASKED, place)).toContain(
		another(join(repo, "py/.venv/src/pkg/.git")),
	);
});

it("grants a folder holding a submodule or worktree whose git folder lies outside it", () => {
	const { home, repo, place } = laid();
	mkdirSync(join(repo, ".git/modules/sub"), { recursive: true });
	mkdirSync(join(repo, ".git/worktrees/side"), { recursive: true });
	mkdirSync(join(repo, "lib/sub"), { recursive: true });
	mkdirSync(join(repo, "lib/side"), { recursive: true });
	writeFileSync(join(repo, "lib/sub/.git"), "gitdir: ../../.git/modules/sub\n");
	writeFileSync(
		join(repo, "lib/side/.git"),
		`gitdir: ${join(repo, ".git/worktrees/side")}\n`,
	);

	expect(unfencedFolder(join(repo, "lib"), home, ASKED, place)).toBeUndefined();
});

it("refuses a folder holding a .git file that names a git folder inside it", () => {
	const { home, repo, place } = laid();
	const held = join(repo, "lib/held");
	mkdirSync(join(held, ".bare/objects"), { recursive: true });
	writeFileSync(join(held, ".bare/HEAD"), "ref: refs/heads/main\n");
	mkdirSync(join(held, "main"), { recursive: true });
	writeFileSync(join(held, "main/.git"), "gitdir: ../.bare\n");

	expect(unfencedFolder(join(repo, "lib"), home, ASKED, place)).toContain(
		"another repository's",
	);
});

it("refuses a folder holding more than the walk can judge, rather than granting it unread", () => {
	const { home, repo, place } = laid();
	const wide = join(repo, "wide");
	for (let at = 0; at <= NESTED_MOST; at += 1) {
		mkdirSync(join(wide, `f${at}`), { recursive: true });
	}

	expect(unfencedFolder(wide, home, ASKED, place)).toContain(
		`more than ${NESTED_MOST} folders`,
	);
});

it("walks past node_modules, which holds no clone git is run in, to a clone beside it", () => {
	const { home, repo, place } = laid();
	const app = join(repo, "app");
	for (let at = 0; at <= NESTED_MOST; at += 1) {
		mkdirSync(join(app, `node_modules/p${at}/lib`), { recursive: true });
	}
	mkdirSync(join(app, "third_party/x/y/.git"), { recursive: true });

	expect(unfencedFolder(app, home, ASKED, place)).toContain(
		another(join(app, "third_party/x/y/.git")),
	);
});

it("grants a tree the work tool cut whole, a vendored clone in it included, as the fence does", () => {
	const { home, place } = laid();
	const tree = join(place.treesRoot, "tree-1");
	mkdirSync(join(tree, "vendor/dep/.git/hooks"), { recursive: true });
	writeFileSync(join(tree, ".git"), "gitdir: /elsewhere/.git/worktrees/t\n");

	expect(
		unfencedFolder(join(tree, "vendor"), home, ASKED, place),
	).toBeUndefined();
});
