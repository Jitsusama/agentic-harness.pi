/**
 * The loaded quest's TMPDIR: a short link to its workspace's tmp/, so
 * temporary files are reaped at conclude and socket paths stay short.
 */

import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { questTempDir } from "../../../extensions/quest-workflow/scratch.ts";

const QUEST = "QEST-20261022-ABC123";
let root: string;
let workspaces: string;
let links: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "quest-scratch-"));
	workspaces = join(root, "workspaces");
	links = join(root, "t");
	mkdirSync(links);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const tmpOf = () => join(workspaces, QUEST, "tmp");

describe("a quest's TMPDIR", () => {
	it("is a short link to the workspace's tmp/, made on first need", () => {
		const dir = questTempDir(workspaces, QUEST, links);

		expect(dir).toBe(join(links, `pi-${QUEST}`));
		expect(readlinkSync(dir ?? "")).toBe(tmpOf());
		expect(lstatSync(tmpOf()).isDirectory()).toBe(true);
	});

	it("keeps a socket path short enough wherever the workspace lives", () => {
		// The longest a Unix socket path may be is 107 characters, and
		// Python's multiprocessing adds 33 to TMPDIR for its own.
		const deep = join(workspaces, "a".repeat(80));

		const dir = questTempDir(deep, QUEST, "/tmp") ?? "";
		try {
			expect(dir.length + 33).toBeLessThan(107);
		} finally {
			rmSync(dir, { force: true });
		}
	});

	it("comes back after conclude clears tmp/", () => {
		const dir = questTempDir(workspaces, QUEST, links);
		rmSync(tmpOf(), { recursive: true });

		expect(questTempDir(workspaces, QUEST, links)).toBe(dir);
		expect(lstatSync(tmpOf()).isDirectory()).toBe(true);
	});

	it("repairs a link of ours that points somewhere else", () => {
		symlinkSync(join(root, "elsewhere"), join(links, `pi-${QUEST}`));

		const dir = questTempDir(workspaces, QUEST, links);

		expect(readlinkSync(dir ?? "")).toBe(tmpOf());
	});

	it("never replaces a file that is not a link, and uses tmp/ itself", () => {
		writeFileSync(join(links, `pi-${QUEST}`), "somebody's");

		expect(questTempDir(workspaces, QUEST, links)).toBe(tmpOf());
	});

	it("is nothing without a quest", () => {
		expect(questTempDir(workspaces, null, links)).toBeUndefined();
	});
});
