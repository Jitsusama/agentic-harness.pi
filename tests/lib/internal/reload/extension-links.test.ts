/**
 * Which extension links moved after the process started: links made
 * since onto other code, and nothing else in the folder.
 */

import { execFileSync } from "node:child_process";
import {
	chmodSync,
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	linkChanges,
	linksMovedSince,
	MOST_BYTES,
	MOST_ENTRIES,
} from "../../../../lib/internal/reload/extension-links.ts";

const dirs: string[] = [];
const storeWas = process.env.NIX_STORE_DIR;
/** Where the module keeps what each process knows, across its reloads. */
const KNOWN = Symbol.for("agentic-harness.reload.extension-links.v1");

afterEach(() => {
	Reflect.deleteProperty(globalThis, KNOWN);
	if (storeWas === undefined) delete process.env.NIX_STORE_DIR;
	else process.env.NIX_STORE_DIR = storeWas;
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
	const dir = mkdtempSync(join(tmpdir(), "extension-links-"));
	dirs.push(dir);
	return dir;
}

/** A tree holding an entry file and a helper beside it, as an extension's. */
function tree(root: string, name: string): string {
	const at = join(root, name);
	mkdirSync(join(at, "lib"), { recursive: true });
	writeFileSync(join(at, "index.ts"), 'export * from "./lib/helper.ts";\n');
	writeFileSync(join(at, "lib", "helper.ts"), "export const a = 1;\n");
	return at;
}

/**
 * An extensions folder whose link the process found on a first tree when
 * it started, an hour after the link was made, then made again onto a
 * second tree, as the Mac's switch makes it. Both trees start the same;
 * `shape` changes them before the move. Both lie in the store unless
 * `store` is false.
 */
function remade(
	shape: (first: string, second: string) => void = () => {},
	{ store = true }: { store?: boolean } = {},
): {
	dir: string;
	root: string;
	first: string;
	second: string;
	startedAt: number;
} {
	const root = realpathSync(folder());
	const first = tree(root, "first");
	const second = tree(root, "second");
	shape(first, second);
	if (store) process.env.NIX_STORE_DIR = root;
	const dir = join(root, "extensions");
	mkdirSync(dir);
	const link = join(dir, "the-proxy");
	symlinkSync(first, link);
	const startedAt = Date.now() - 60_000;
	const hourBefore = (startedAt - 3_600_000) / 1000;
	lutimesSync(link, hourBefore, hourBefore);
	expect(linksMovedSince(dir, startedAt), "nothing moved yet").toEqual([]);
	rmSync(link);
	symlinkSync(second, link);
	return { dir, root, first, second, startedAt };
}

/** Makes the link in `dir` again, onto `target`. */
function remake(dir: string, target: string): void {
	rmSync(join(dir, "the-proxy"));
	symlinkSync(target, join(dir, "the-proxy"));
}

/** Whether this process runs as root, which reads a file whatever its mode. */
const asRoot = process.getuid?.() === 0;

/** Whether `mkfifo` can be run here, to make a FIFO for a tree to hold. */
const hasMkfifo = (() => {
	try {
		execFileSync("mkfifo", ["--version"], { stdio: "ignore" });
		return true;
	} catch (error) {
		// Found but refusing the flag, as BSD's does, is still there.
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
})();

describe("extension links moved since a process started", () => {
	it("names a link made since, and not one made before or a real folder", () => {
		const dir = folder();
		const startedAt = Date.now();
		symlinkSync("/nix/store/a-target", join(dir, "made-before"));
		// An hour before the process, as a link left from an earlier launch.
		const hourBefore = (startedAt - 3_600_000) / 1000;
		lutimesSync(join(dir, "made-before"), hourBefore, hourBefore);
		symlinkSync("/nix/store/gone-target", join(dir, "made-since"));
		mkdirSync(join(dir, "a-folder"));

		expect(
			linksMovedSince(dir, startedAt - 60_000),
			"only the link made after the start",
		).toEqual(["made-since"]);
	});

	it("names no link made again onto a store tree the same as its first", () => {
		const { dir, startedAt } = remade();

		expect(
			linksMovedSince(dir, startedAt),
			"the same entry and helpers read from either tree",
		).toEqual([]);
	});

	it("keeps what it first found through a reload of this module", async () => {
		const { dir, startedAt } = remade();
		vi.resetModules();
		const again = await import(
			"../../../../lib/internal/reload/extension-links.ts"
		);

		expect(
			again.linksMovedSince(dir, startedAt),
			"a fresh module would find the link made since, and no first target",
		).toEqual([]);
	});

	it.each<[string, string, (first: string, second: string) => void]>([
		[
			"a file that differs by a byte",
			"differs",
			(_first: string, second: string) =>
				writeFileSync(
					join(second, "lib", "helper.ts"),
					"export const a = 2;\n",
				),
		],
		[
			"a file with the same bytes under another name",
			"differs",
			(_first: string, second: string) =>
				renameSync(
					join(second, "lib", "helper.ts"),
					join(second, "lib", "helpers.ts"),
				),
		],
		[
			"an empty folder more",
			"differs",
			(_first: string, second: string) => mkdirSync(join(second, "empty")),
		],
		[
			"a link inside it that leads elsewhere",
			"differs",
			(first: string, second: string) => {
				symlinkSync("lib/helper.ts", join(first, "alias.ts"));
				symlinkSync("index.ts", join(second, "alias.ts"));
			},
		],
		[
			"a link inside it that leads out of it",
			"inner link leads out",
			(first: string, second: string) => {
				symlinkSync("../shared", join(first, "shared"));
				symlinkSync("../shared", join(second, "shared"));
			},
		],
		[
			"a link inside it that leads out through another",
			"inner link leads out",
			(first: string, second: string) => {
				// `lib/q` is the tree itself, so `lib/q/..` is the folder above
				// it, though the text reads as `lib/shared`.
				for (const at of [first, second]) {
					writeFileSync(join(at, "..", "shared"), "");
					symlinkSync("..", join(at, "lib", "q"));
					symlinkSync("lib/q/../shared", join(at, "shared"));
				}
			},
		],
		[
			"more entries than it reads",
			"too big",
			(first: string, second: string) => {
				for (const at of [first, second]) {
					mkdirSync(join(at, "many"));
					for (let n = 0; n < MOST_ENTRIES; n += 1)
						writeFileSync(join(at, "many", String(n)), "");
				}
			},
		],
		[
			"more bytes than it reads",
			"too big",
			(first: string, second: string) => {
				for (const at of [first, second]) {
					writeFileSync(join(at, "big"), "");
					truncateSync(join(at, "big"), MOST_BYTES + 1);
				}
			},
		],
	])(
		"names a link made again onto a tree with %s, saying %s",
		(_what, verdict, shape) => {
			const { dir, startedAt } = remade(shape);

			// The verdict, not only the move: a walk that followed links would
			// still count most of these moved, for another reason.
			expect(
				linkChanges(dir, startedAt),
				"it can't be shown to load the same code",
			).toEqual([{ name: "the-proxy", verdict }]);
		},
	);

	// 85PKB2's F47 on #2246: a move is read whole once, so the check a
	// session makes at each look costs nothing after its first.
	it("reads a move whole once, keeping its verdict for the next look", () => {
		const { dir, second, startedAt } = remade();
		expect(linksMovedSince(dir, startedAt), "the first look").toEqual([]);
		// A store tree never changes once made; one that did here could
		// only be seen by reading it again.
		writeFileSync(join(second, "lib", "helper.ts"), "export const a = 2;\n");

		expect(
			linksMovedSince(dir, startedAt),
			"the next look keeps the verdict read whole",
		).toEqual([]);
	});

	it("names no link made again onto the same trees at their caps", () => {
		const { dir, startedAt } = remade((first, second) => {
			for (const at of [first, second]) {
				// The tree, index.ts, lib and its helper are four entries;
				// `many` and the file that fills the byte cap two more.
				mkdirSync(join(at, "many"));
				for (let n = 0; n < MOST_ENTRIES - 6; n += 1)
					writeFileSync(join(at, "many", String(n)), "");
				const written =
					statSync(join(at, "index.ts")).size +
					statSync(join(at, "lib", "helper.ts")).size;
				writeFileSync(join(at, "many", "big"), "");
				truncateSync(join(at, "many", "big"), MOST_BYTES - written);
			}
		});

		expect(linksMovedSince(dir, startedAt), "read whole, and the same").toEqual(
			[],
		);
	});

	it.skipIf(asRoot)(
		"names a link made again onto a tree with a file it can't read, and reads it again",
		() => {
			const helper = (second: string) => join(second, "lib", "helper.ts");
			const { dir, second, startedAt } = remade((_first, second) =>
				chmodSync(helper(second), 0o000),
			);
			expect(
				linkChanges(dir, startedAt),
				"it can't be shown to load the same code",
			).toEqual([{ name: "the-proxy", verdict: "unreadable" }]);

			chmodSync(helper(second), 0o644);

			expect(
				linksMovedSince(dir, startedAt),
				"a read that failed is no verdict, so the next look reads again",
			).toEqual([]);
		},
	);

	it("says why each link made since counts", () => {
		const { dir, startedAt } = remade((_first, second) =>
			writeFileSync(join(second, "lib", "helper.ts"), "export const a = 2;\n"),
		);
		symlinkSync(join(dir, "nowhere"), join(dir, "made-since"));

		expect(linkChanges(dir, startedAt), "in name order").toEqual([
			{ name: "made-since", verdict: "first unknown" },
			{ name: "the-proxy", verdict: "differs" },
		]);
	});

	it("names a second move onto other code after a first onto the same", () => {
		const { dir, root, startedAt } = remade();
		expect(linksMovedSince(dir, startedAt), "the first move").toEqual([]);
		const third = tree(root, "third");
		writeFileSync(join(third, "lib", "helper.ts"), "export const a = 3;\n");

		remake(dir, third);

		expect(
			linksMovedSince(dir, startedAt),
			"each move is compared on its own",
		).toEqual(["the-proxy"]);
	});

	it.each([
		["in the store", true],
		["outside the store", false],
	])(
		"names no link made again onto its own first target, %s",
		(_where, store) => {
			const { dir, first, startedAt } = remade(() => {}, { store });

			remake(dir, first);

			expect(
				linkChanges(dir, startedAt),
				"its resolver already holds that target, so it is no move",
			).toEqual([]);
		},
	);

	it("names a link to a single file made again onto the same file", () => {
		const root = realpathSync(folder());
		process.env.NIX_STORE_DIR = root;
		const first = tree(root, "first");
		const second = tree(root, "second");
		writeFileSync(join(second, "lib", "helper.ts"), "export const a = 2;\n");
		const dir = join(root, "extensions");
		mkdirSync(dir);
		const link = join(dir, "the-proxy.ts");
		symlinkSync(join(first, "index.ts"), link);
		const startedAt = Date.now() - 60_000;
		const hourBefore = (startedAt - 3_600_000) / 1000;
		lutimesSync(link, hourBefore, hourBefore);
		expect(linksMovedSince(dir, startedAt), "nothing moved yet").toEqual([]);

		rmSync(link);
		symlinkSync(join(second, "index.ts"), link);

		expect(
			linkChanges(dir, startedAt),
			"its helpers lie beside it, outside what is compared",
		).toEqual([{ name: "the-proxy.ts", verdict: "not a folder" }]);
	});

	it("names a link made again onto a tree beside the store that shares its name", () => {
		const { dir, root, startedAt } = remade();
		remake(dir, tree(root, "fixed"));
		process.env.NIX_STORE_DIR = join(root, "fi");

		expect(
			linkChanges(dir, startedAt),
			"first and fixed only start with the store's name",
		).toEqual([{ name: "the-proxy", verdict: "outside the store" }]);
	});

	it("takes no tree for the store's when its name is relative", () => {
		const { dir, root, startedAt } = remade();
		// Resolved from where pi runs, the name would be the trees' own root.
		process.env.NIX_STORE_DIR = relative(process.cwd(), root);

		expect(
			linkChanges(dir, startedAt),
			"the default store holds neither tree",
		).toEqual([{ name: "the-proxy", verdict: "outside the store" }]);
	});

	it("takes no tree for the store's when its name is empty", () => {
		const { dir, root, startedAt } = remade();
		process.env.NIX_STORE_DIR = "";
		// Resolved, an empty name is wherever pi runs: here, the trees' root.
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
		try {
			expect(
				linkChanges(dir, startedAt),
				"the default store holds neither tree",
			).toEqual([{ name: "the-proxy", verdict: "outside the store" }]);
		} finally {
			cwd.mockRestore();
		}
	});

	it("takes no tree for the store's when its name is the disk's root", () => {
		const { dir, startedAt } = remade();
		process.env.NIX_STORE_DIR = "/";

		expect(
			linkChanges(dir, startedAt),
			"no real path begins with two separators",
		).toEqual([{ name: "the-proxy", verdict: "outside the store" }]);
	});

	it.skipIf(!hasMkfifo)(
		"names a link made again onto a tree holding a FIFO, without opening it",
		() => {
			const { dir, startedAt } = remade((first, second) => {
				for (const at of [first, second])
					execFileSync("mkfifo", [join(at, "pipe")]);
			});

			expect(
				linkChanges(dir, startedAt),
				"it holds for good, unlike a read that failed",
			).toEqual([{ name: "the-proxy", verdict: "not a file" }]);
		},
	);

	it("answers each start with the first targets found under it", () => {
		const root = realpathSync(folder());
		process.env.NIX_STORE_DIR = root;
		const first = tree(root, "first");
		const second = tree(root, "second");
		const dir = join(root, "extensions");
		mkdirSync(dir);
		const link = join(dir, "the-proxy");
		symlinkSync(first, link);
		const madeAt = Date.now() - 60_000;
		lutimesSync(link, madeAt / 1000, madeAt / 1000);
		expect(
			linkChanges(dir, madeAt + 1_000),
			"under a start after it was made, its first target is noted",
		).toEqual([]);

		remake(dir, second);

		expect(
			linkChanges(dir, madeAt - 1_000),
			"under a start before it was made, nothing was noted",
		).toEqual([{ name: "the-proxy", verdict: "first unknown" }]);
	});

	it("names no link made again onto a tree whose inner links are the same", () => {
		const { dir, startedAt } = remade((first, second) => {
			symlinkSync("lib/helper.ts", join(first, "alias.ts"));
			symlinkSync("lib/helper.ts", join(second, "alias.ts"));
		});

		expect(linksMovedSince(dir, startedAt), "the same tree").toEqual([]);
	});

	it("names a link made again onto the same tree outside the store", () => {
		const { dir, startedAt } = remade(() => {}, { store: false });

		expect(
			linksMovedSince(dir, startedAt),
			"a tree outside the store can change after it is compared",
		).toEqual(["the-proxy"]);
	});

	it("names a link whose first target is gone, though the trees were the same", () => {
		const { dir, first, startedAt } = remade();
		expect(
			linksMovedSince(dir, startedAt),
			"the same while both stand",
		).toEqual([]);

		rmSync(first, { recursive: true });

		expect(
			linksMovedSince(dir, startedAt),
			"a reload's imports resolve against the collected first target",
		).toEqual(["the-proxy"]);
	});

	it("names a link the process first found already made since it started", () => {
		const root = realpathSync(folder());
		process.env.NIX_STORE_DIR = root;
		const first = tree(root, "first");
		const second = tree(root, "second");
		const dir = join(root, "extensions");
		mkdirSync(dir);
		const startedAt = Date.now() - 60_000;
		symlinkSync(first, join(dir, "the-proxy"));
		expect(
			linksMovedSince(dir, startedAt),
			"where its resolver first found it is unknown",
		).toEqual(["the-proxy"]);

		rmSync(join(dir, "the-proxy"));
		symlinkSync(second, join(dir, "the-proxy"));

		expect(
			linksMovedSince(dir, startedAt),
			"so a same tree can't be shown the same as it",
		).toEqual(["the-proxy"]);
	});

	it("names a link made again onto nothing", () => {
		const { dir, startedAt } = remade();
		rmSync(join(dir, "the-proxy"));
		symlinkSync(join(dir, "nowhere"), join(dir, "the-proxy"));

		expect(linksMovedSince(dir, startedAt), "nothing to load the same").toEqual(
			["the-proxy"],
		);
	});

	it("names nothing when the folder can't be read", () => {
		expect(
			linksMovedSince(join(folder(), "missing"), 0),
			"a missing folder has loaded nothing",
		).toEqual([]);
	});
});
