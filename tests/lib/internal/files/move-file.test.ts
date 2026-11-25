/**
 * A file moved whole between two folders, by rename where both lie on
 * one volume and by a copy beside its place where they don't, as a btrfs
 * subvolume answers a rename from outside it.
 */

import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moveFile } from "../../../../lib/internal/files/move-file.ts";

/** The folders that are volumes of their own, which a rename can't cross. */
const volumes = vi.hoisted((): string[] => []);

/** Every rename made, as from and to, in order. */
const renames = vi.hoisted((): [string, string][] => []);

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const volumeOf = (path: string) =>
		volumes.find((volume) => path.startsWith(`${volume}/`)) ?? "";
	return {
		...real,
		renameSync: (...args: Parameters<typeof real.renameSync>) => {
			const [from, to] = [String(args[0]), String(args[1])];
			renames.push([from, to]);
			if (volumeOf(from) !== volumeOf(to)) {
				throw Object.assign(
					new Error(`EXDEV: cross-device link not permitted, rename '${from}'`),
					{ code: "EXDEV" },
				);
			}
			real.renameSync(...args);
		},
	};
});

const made: string[] = [];
afterEach(() => {
	volumes.length = 0;
	renames.length = 0;
	for (const path of made.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

/** Two folders, each a volume of its own unless `oneVolume`. */
function twoFolders(oneVolume = false): { here: string; there: string } {
	const root = mkdtempSync(join(tmpdir(), "move-file-"));
	made.push(root);
	const here = join(root, "here");
	const there = join(root, "there");
	mkdirSync(here);
	mkdirSync(there);
	if (!oneVolume) volumes.push(here, there);
	return { here, there };
}

describe("moving a file whole", () => {
	it("renames it where both folders lie on one volume", () => {
		const { here, there } = twoFolders(true);
		writeFileSync(join(here, "log.jsonl"), "kept\n");

		moveFile(join(here, "log.jsonl"), join(there, "log.jsonl"));

		expect(renames).toEqual([
			[join(here, "log.jsonl"), join(there, "log.jsonl")],
		]);
		expect(readFileSync(join(there, "log.jsonl"), "utf8")).toBe("kept\n");
		expect(readdirSync(here)).toEqual([]);
	});

	it("copies it beside its place and renames it in across volumes, keeping its bytes and mode", () => {
		const { here, there } = twoFolders();
		const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, "carried\n");
		writeFileSync(join(here, "log.jsonl"), bytes, { mode: 0o640 });

		moveFile(join(here, "log.jsonl"), join(there, "log.jsonl"));

		expect(readFileSync(join(there, "log.jsonl")).equals(bytes)).toBe(true);
		expect(statSync(join(there, "log.jsonl")).mode & 0o777).toBe(0o640);
		expect(readdirSync(here), "the original is gone").toEqual([]);
		expect(readdirSync(there), "nothing is left beside it").toEqual([
			"log.jsonl",
		]);
		const last = renames.at(-1);
		expect(last?.[1], "the copy is renamed into its place").toBe(
			join(there, "log.jsonl"),
		);
		expect(last?.[0].startsWith(`${there}/`), "from beside its place").toBe(
			true,
		);
	});

	it("replaces what stands at its place across volumes", () => {
		const { here, there } = twoFolders();
		writeFileSync(join(here, "done.json"), "new\n");
		writeFileSync(join(there, "done.json"), "old\n");

		moveFile(join(here, "done.json"), join(there, "done.json"));

		expect(readFileSync(join(there, "done.json"), "utf8")).toBe("new\n");
		expect(readdirSync(there)).toEqual(["done.json"]);
	});

	it("moves a link as a link across volumes, never reading what it points at", () => {
		const { here, there } = twoFolders();
		const victim = join(made[0] ?? "", "victim.txt");
		writeFileSync(victim, "secret\n");
		symlinkSync(victim, join(here, "planted"));

		moveFile(join(here, "planted"), join(there, "planted"));

		expect(lstatSync(join(there, "planted")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(there, "planted"))).toBe(victim);
		expect(readdirSync(here)).toEqual([]);
		expect(readFileSync(victim, "utf8"), "what it points at stays").toBe(
			"secret\n",
		);
	});

	it("refuses a folder across volumes, leaving it and nothing beside its place", () => {
		const { here, there } = twoFolders();
		mkdirSync(join(here, "trees"));
		writeFileSync(join(here, "trees", "kept.txt"), "kept\n");

		expect(() => moveFile(join(here, "trees"), join(there, "trees"))).toThrow(
			"isn't a file or a link",
		);

		expect(readdirSync(join(here, "trees"))).toEqual(["kept.txt"]);
		expect(readdirSync(there)).toEqual([]);
	});

	it("throws any other failure of the rename as it was, copying nothing", () => {
		const { here, there } = twoFolders(true);

		expect(() =>
			moveFile(join(here, "missing"), join(there, "missing")),
		).toThrow(/ENOENT/);

		expect(readdirSync(there)).toEqual([]);
	});
});
