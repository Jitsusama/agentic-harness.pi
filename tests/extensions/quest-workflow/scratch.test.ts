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
import {
	questCommandEnvironment,
	questTempDir,
	TEMP_LINK_PREFIX,
} from "../../../extensions/quest-workflow/scratch.ts";

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

		expect(dir).toBe(join(links, `${TEMP_LINK_PREFIX}${QUEST}`));
		expect(readlinkSync(dir ?? "")).toBe(tmpOf());
		expect(lstatSync(tmpOf()).isDirectory()).toBe(true);
	});

	it("carries the name disk-guard leaves alone", () => {
		// disk-guard's temp pass takes a made-up name it finds idle, and
		// pi-QEST-<id> ends in a run with digits in it, so it read as
		// one. On 24 October it took eleven of these links under urgent
		// pressure, and a background job reading through one found no
		// such file until its session's next command made it again.
		// pi-quest- is the prefix disk-guard keeps for the harness.
		const dir = questTempDir(workspaces, QUEST, links) ?? "";

		expect(TEMP_LINK_PREFIX).toBe("pi-quest-");
		expect(dir.slice(links.length + 1).startsWith("pi-quest-")).toBe(true);
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
		symlinkSync(
			join(root, "elsewhere"),
			join(links, `${TEMP_LINK_PREFIX}${QUEST}`),
		);

		const dir = questTempDir(workspaces, QUEST, links);

		expect(readlinkSync(dir ?? "")).toBe(tmpOf());
	});

	it("never replaces a file that is not a link, and uses tmp/ itself", () => {
		writeFileSync(join(links, `${TEMP_LINK_PREFIX}${QUEST}`), "somebody's");

		expect(questTempDir(workspaces, QUEST, links)).toBe(tmpOf());
	});

	it("is nothing without a quest", () => {
		expect(questTempDir(workspaces, null, links)).toBeUndefined();
	});
});

describe("what a quest's commands carry", () => {
	// The machine shares CPU and disk by quest: what sorts a command
	// into its quest's cgroup reads the quest from its environment.
	it("names the quest and its TMPDIR", () => {
		expect(questCommandEnvironment(workspaces, QUEST, links)).toEqual({
			PI_QUEST: QUEST,
			TMPDIR: join(links, `${TEMP_LINK_PREFIX}${QUEST}`),
		});
	});

	it("names the quest even when its temp folder can't be made", () => {
		writeFileSync(workspaces, "not a folder");

		expect(questCommandEnvironment(workspaces, QUEST, links)).toEqual({
			PI_QUEST: QUEST,
		});
	});

	it("is nothing without a quest", () => {
		expect(questCommandEnvironment(workspaces, null, links)).toBeUndefined();
	});
});
