/**
 * The loaded quest's TMPDIR: a short link to its workspace's tmp/, so
 * temporary files go at conclude and socket paths stay short.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	dropTempLink,
	questCommandEnvironment,
	questTempDir,
	TEMP_LINK_PREFIX,
} from "../../../../extensions/quest-workflow/scratch.ts";
import { removeQuestWorkspace } from "../../../../lib/core/internal/quest/workspace.ts";

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
		expect(lstatSync(tmpOf()).isDirectory(), `${tmpOf()} is a folder`).toBe(
			true,
		);
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
		expect(dir.slice(links.length + 1)).toMatch(/^pi-quest-/);
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
		expect(lstatSync(tmpOf()).isDirectory(), `${tmpOf()} is a folder`).toBe(
			true,
		);
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

	it("says once that it is tmp/ itself, so a link that can't be made is seen", () => {
		const said = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			writeFileSync(join(links, `${TEMP_LINK_PREFIX}${QUEST}`), "somebody's");

			questTempDir(workspaces, QUEST, links);
			questTempDir(workspaces, QUEST, links);

			const lines = said.mock.calls
				.map(([line]) => String(line))
				.filter((line) => line.includes("couldn't be made"));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain(tmpOf());
		} finally {
			said.mockRestore();
		}
	});

	it("is nothing without a quest", () => {
		expect(questTempDir(workspaces, null, links)).toBeUndefined();
	});
});

describe("where a quest's TMPDIR link lies", () => {
	afterEach(() => vi.unstubAllEnvs());

	// A Mac's fence closes its runtime folder whole, so its links stay in /tmp.
	it.skipIf(process.platform !== "linux")(
		"is the login's runtime folder when it is this account's alone, out of /tmp",
		() => {
			// /tmp is anybody's to empty: on 22 November a test suite run with
			// no TMPDIR took every name in it, the quests' links among them.
			const runtime = join(root, "run");
			mkdirSync(runtime, { mode: 0o700 });
			vi.stubEnv("XDG_RUNTIME_DIR", runtime);

			const dir = questTempDir(workspaces, QUEST) ?? "";

			expect(dir).toBe(join(runtime, `${TEMP_LINK_PREFIX}${QUEST}`));
			expect(readlinkSync(dir)).toBe(tmpOf());
		},
	);

	it.skipIf(process.platform !== "linux")(
		"is made again by the next command once the runtime folder is emptied",
		() => {
			// The user manager empties the runtime folder when it stops, so a
			// link made only as the quest loaded would leave TMPDIR dangling.
			const runtime = join(root, "run");
			mkdirSync(runtime, { mode: 0o700 });
			vi.stubEnv("XDG_RUNTIME_DIR", runtime);
			const link = join(runtime, `${TEMP_LINK_PREFIX}${QUEST}`);
			questCommandEnvironment(workspaces, QUEST);
			rmSync(link);

			const env = questCommandEnvironment(workspaces, QUEST);

			expect(env?.TMPDIR).toBe(link);
			expect(readlinkSync(link)).toBe(tmpOf());
		},
	);

	it("is the system temp directory when the runtime folder is open to others", () => {
		const runtime = join(root, "run");
		mkdirSync(runtime, { mode: 0o755 });
		vi.stubEnv("XDG_RUNTIME_DIR", runtime);
		// Its own id, as /tmp is shared with every other run on the machine.
		const own = process.pid.toString(36).toUpperCase().padStart(6, "0");
		const quest = `QEST-20260101-${own.slice(-6)}`;

		const dir = questTempDir(workspaces, quest) ?? "";
		try {
			expect(dir).toBe(join("/tmp", `${TEMP_LINK_PREFIX}${quest}`));
		} finally {
			dropTempLink(quest, ["/tmp"]);
		}
	});
});

describe("a quest's compiled TypeScript", () => {
	const shared = () => join(root, "system", "jiti");
	const cacheOf = () => join(tmpOf(), "jiti");
	const made = () =>
		questTempDir(workspaces, QUEST, links, undefined, shared());

	it("goes in the cache every pi shares, so a first start finds it compiled", () => {
		made();

		expect(
			lstatSync(cacheOf()).isSymbolicLink(),
			`${cacheOf()} is a link`,
		).toBe(true);
		expect(readlinkSync(cacheOf())).toBe(shared());
		expect(lstatSync(shared()).isDirectory(), `${shared()} is a folder`).toBe(
			true,
		);
	});

	it("replaces a quest's own copy with the link", async () => {
		mkdirSync(cacheOf(), { recursive: true });
		writeFileSync(join(cacheOf(), "a.1234abcd.mjs"), "export {}");

		made();

		expect(readlinkSync(cacheOf())).toBe(shared());
		await vi.waitFor(
			() =>
				expect(
					readdirSync(tmpOf()).filter((name) => name.startsWith("jiti.old-")),
				).toEqual([]),
			{ timeout: 5_000 },
		);
	});

	it("leaves the shared cache whole when the quest's scratch is removed", async () => {
		made();
		writeFileSync(join(shared(), "a.1234abcd.mjs"), "export {}");

		expect(await removeQuestWorkspace(workspaces, QUEST, () => [])).toEqual({
			removed: true,
		});
		expect(
			existsSync(join(shared(), "a.1234abcd.mjs")),
			`${join(shared(), "a.1234abcd.mjs")} is kept`,
		).toBe(true);
	});

	it("keeps its own when the pi itself runs inside the quest's TMPDIR", () => {
		questTempDir(workspaces, QUEST, links, undefined, cacheOf());

		expect(
			lstatSync(cacheOf()).isDirectory(),
			`${cacheOf()} is a folder of its own, not a link`,
		).toBe(true);
	});
});

describe("what a quest's commands carry", () => {
	// The machine shares CPU and disk by quest: what sorts a command
	// into its quest's cgroup reads the quest from its environment.
	it("names the quest, its TMPDIR and Go's caches in its scratch folder", () => {
		expect(questCommandEnvironment(workspaces, QUEST, links)).toEqual({
			PI_QUEST: QUEST,
			TMPDIR: join(links, `${TEMP_LINK_PREFIX}${QUEST}`),
			GOCACHE: join(workspaces, QUEST, "cache", "go-build"),
			GOMODCACHE: join(workspaces, QUEST, "cache", "go-mod"),
		});
	});

	it("names the quest even when its temp folder can't be made", () => {
		writeFileSync(workspaces, "not a folder");

		expect(questCommandEnvironment(workspaces, QUEST, links)).toEqual({
			PI_QUEST: QUEST,
		});
	});

	it("takes away its link once the scratch folder is gone, and only its own", () => {
		const link = questTempDir(workspaces, QUEST, links) ?? "";
		const other = "QEST-20260101-OTHERS";
		symlinkSync(
			join(workspaces, "elsewhere"),
			join(links, `${TEMP_LINK_PREFIX}${other}`),
		);

		dropTempLink(QUEST, [links]);
		dropTempLink("QEST-20260101-NOLINK", [links]);

		expect(existsSync(link), `${link} is removed`).toBe(false);
		expect(
			lstatSync(join(links, `${TEMP_LINK_PREFIX}${other}`)).isSymbolicLink(),
			`${join(links, `${TEMP_LINK_PREFIX}${other}`)} is still a link`,
		).toBe(true);
	});

	it("is nothing without a quest", () => {
		expect(questCommandEnvironment(workspaces, null, links)).toBeUndefined();
	});
});
