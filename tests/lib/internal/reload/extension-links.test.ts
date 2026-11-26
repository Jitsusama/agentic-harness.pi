/**
 * Which extension links moved after the process started: links made
 * since onto other code, and nothing else in the folder.
 */

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
import { join } from "node:path";
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

	it.each([
		[
			"a file that differs by a byte",
			(_first: string, second: string) =>
				writeFileSync(
					join(second, "lib", "helper.ts"),
					"export const a = 2;\n",
				),
		],
		[
			"a file with the same bytes under another name",
			(_first: string, second: string) =>
				renameSync(
					join(second, "lib", "helper.ts"),
					join(second, "lib", "helpers.ts"),
				),
		],
		[
			"an empty folder more",
			(_first: string, second: string) => mkdirSync(join(second, "empty")),
		],
		[
			"a link inside it that leads elsewhere",
			(first: string, second: string) => {
				symlinkSync("lib/helper.ts", join(first, "alias.ts"));
				symlinkSync("index.ts", join(second, "alias.ts"));
			},
		],
		[
			"a link inside it that leads out of it",
			(first: string, second: string) => {
				symlinkSync("../shared", join(first, "shared"));
				symlinkSync("../shared", join(second, "shared"));
			},
		],
		[
			"a link inside it that leads out through another",
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
			(first: string, second: string) => {
				for (const at of [first, second]) {
					writeFileSync(join(at, "big"), "");
					truncateSync(join(at, "big"), MOST_BYTES + 1);
				}
			},
		],
	])("names a link made again onto a tree with %s", (_what, shape) => {
		const { dir, startedAt } = remade(shape);

		expect(
			linksMovedSince(dir, startedAt),
			"it can't be shown to load the same code",
		).toEqual(["the-proxy"]);
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
				linksMovedSince(dir, startedAt),
				"its resolver already holds that target",
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

	it.each([
		["empty", ""],
		["relative", "store"],
		["the disk's root", "/"],
	])("takes no tree for the store's when its name is %s", (_what, named) => {
		const { dir, startedAt } = remade();
		process.env.NIX_STORE_DIR = named;

		expect(
			linkChanges(dir, startedAt),
			"the default store holds neither tree",
		).toEqual([{ name: "the-proxy", verdict: "outside the store" }]);
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
