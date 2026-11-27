/**
 * What a fenced command can move above what the fence closes, through
 * a real bubblewrap over a home folder of its own: neither pi's state
 * nor any folder above it, the host's record of each session's fence
 * among it, nor the folders holding quests' scratches, while the
 * folders beside them stay as writable as they were. It skips only
 * where no bubblewrap can make a namespace, as inside another sandbox.
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fenceArgs } from "../../../../lib/internal/fence/fence.ts";
import { pinnedAbove } from "../../../../lib/internal/fence/fence-pins.ts";

/** A bubblewrap on `PATH` that can make a namespace here, or nothing. */
function workingBwrap(): string | undefined {
	const found = spawnSync("bash", ["-c", "command -v bwrap"], {
		encoding: "utf8",
	}).stdout.trim();
	if (!found) return undefined;
	const tried = spawnSync(found, [
		"--unshare-user",
		"--ro-bind",
		"/",
		"/",
		"true",
	]);
	return tried.status === 0 ? found : undefined;
}

const bwrap = workingBwrap();

describe.skipIf(bwrap === undefined)(
	"what a fenced command can move above what the fence closes",
	() => {
		let home: string;
		let hosts: string;
		let scratches: string;
		let own: string;

		/** Whether `script` succeeds as a fenced command in `home`. */
		function fenced(script: string): boolean {
			const args = fenceArgs({
				home,
				runtimeDir: undefined,
				scratch: { root: scratches, own },
			});
			const ran = spawnSync(
				bwrap ?? "bwrap",
				["--unshare-user", ...args, "sh", "-c", script],
				{ encoding: "utf8" },
			);
			return ran.status === 0;
		}

		beforeAll(() => {
			home = realpathSync(mkdtempSync(join(tmpdir(), "fence-pins-")));
			hosts = join(home, ".local/state/pi/agentic-harness.pi/hosts");
			mkdirSync(hosts, { recursive: true });
			writeFileSync(join(hosts, "1-2.json"), "{}");
			mkdirSync(join(home, ".local/state/other"), { recursive: true });
			mkdirSync(join(home, ".local/share"), { recursive: true });
			scratches = join(home, ".cache/pi/agentic-harness.pi/quest-workspace");
			own = join(scratches, "QEST-20261119-AAAAAA");
			mkdirSync(own, { recursive: true });
			mkdirSync(join(home, ".cache/other"), { recursive: true });
		});

		afterAll(() => {
			rmSync(home, { recursive: true, force: true });
		});

		it("writes, renames and replaces nothing in the host's records", () => {
			const record = join(hosts, "1-2.json");
			expect(fenced(`echo x > ${record}`), "a record written").toBe(false);
			expect(fenced(`mv ${record} ${hosts}/3-4.json`), "renamed").toBe(false);
			expect(fenced(`mv ${hosts} ${home}/hosts`), "the folder moved").toBe(
				false,
			);
			expect(readFileSync(record, "utf8")).toBe("{}");
		});

		it("moves no folder above pi's state, so none stands in its place", () => {
			for (const folder of [".local/state", ".local"]) {
				expect(
					fenced(`mv ${home}/${folder} ${home}/${folder}-moved`),
					`${folder} moved`,
				).toBe(false);
				expect(existsSync(join(home, folder)), `${folder} is gone`).toBe(true);
			}
			expect(
				existsSync(join(hosts, "1-2.json")),
				"the host's record is gone",
			).toBe(true);
		});

		it("moves no folder above quests' scratches", () => {
			for (const folder of [
				".cache",
				".cache/pi",
				".cache/pi/agentic-harness.pi",
			]) {
				expect(
					fenced(`mv ${home}/${folder} ${home}/${folder}-moved`),
					`${folder} moved`,
				).toBe(false);
			}
			expect(existsSync(own), "the quest's own scratch is gone").toBe(true);
		});

		it("still writes beside them as before", () => {
			expect(
				fenced(
					`touch ${home}/.local/state/other/f && mkdir ${home}/.local/state/new && mv ${home}/.local/state/new ${home}/.local/state/newer && touch ${own}/f && touch ${home}/.cache/other/f && mkdir ${home}/.cache/pi/made`,
				),
				"a write beside the pinned folders was refused",
			).toBe(true);
			expect(
				existsSync(join(home, ".local/state/newer")),
				"the folder made and renamed beside them is gone",
			).toBe(true);
		});

		// Its records lie past the link, so they name no fence (session-host).
		it("leaves a home whose state is a link as writable as it was", () => {
			const linked = realpathSync(
				mkdtempSync(join(tmpdir(), "fence-pins-link-")),
			);
			try {
				const place = join(linked, "home");
				const elsewhere = join(linked, "state");
				mkdirSync(join(place, ".local/share"), { recursive: true });
				mkdirSync(join(elsewhere, "pi"), { recursive: true });
				symlinkSync(elsewhere, join(place, ".local/state"));
				const args = fenceArgs({ home: place, runtimeDir: undefined });
				const ran = spawnSync(
					bwrap ?? "bwrap",
					[
						"--unshare-user",
						...args,
						"sh",
						"-c",
						`touch ${place}/.local/share/f && mkdir ${place}/.local/lib`,
					],
					{ encoding: "utf8" },
				);
				expect(ran.status, ran.stderr).toBe(0);
				expect(
					existsSync(join(place, ".local/lib")),
					"no folder was made in .local",
				).toBe(true);
			} finally {
				rmSync(linked, { recursive: true, force: true });
			}
		});
	},
);

describe("where the fence pins a folder", () => {
	const folders = new Set(["/h/.a", "/h/.a/b", "/h/.a/b/c"]);
	const disk = {
		kind: (path: string) =>
			folders.has(path) ? ("folder" as const) : undefined,
		entries: () => [],
	};

	it("pins each folder above a closed path, after its holder and before what lies in it", () => {
		expect(
			pinnedAbove(
				[
					"--ro-bind",
					"/h",
					"/h",
					"--bind",
					"/h/.a",
					"/h/.a",
					"--ro-bind",
					"/h/.a/b/c",
					"/h/.a/b/c",
				],
				"/h",
				disk,
			),
		).toEqual([
			"--ro-bind",
			"/h",
			"/h",
			"--bind",
			"/h/.a",
			"/h/.a",
			"--bind",
			"/h/.a/b",
			"/h/.a/b",
			"--ro-bind",
			"/h/.a/b/c",
			"/h/.a/b/c",
		]);
	});

	it("pins each folder above a named home outside the home folder, up to the disk's top", () => {
		const named = {
			kind: (path: string) =>
				["/w", "/w/runs", "/w/runs/a"].includes(path)
					? ("folder" as const)
					: undefined,
			entries: () => [],
		};
		expect(
			pinnedAbove(
				["--bind", "/", "/", "--ro-bind", "/w/runs/a", "/w/runs/a"],
				"/h",
				named,
				["/w/runs/a"],
			),
		).toEqual([
			"--bind",
			"/",
			"/",
			"--bind",
			"/w",
			"/w",
			"--bind",
			"/w/runs",
			"/w/runs",
			"--ro-bind",
			"/w/runs/a",
			"/w/runs/a",
		]);
		expect(
			pinnedAbove(
				["--bind", "/", "/", "--ro-bind", "/w/runs/a", "/w/runs/a"],
				"/h",
				named,
			),
			"a folder outside the home folder no setting names is left as it was",
		).toEqual(["--bind", "/", "/", "--ro-bind", "/w/runs/a", "/w/runs/a"]);
	});

	it("pins before the --perms a mount takes, never between them", () => {
		expect(
			pinnedAbove(
				["--bind", "/h", "/h", "--perms", "0700", "--tmpfs", "/h/.a/b"],
				"/h",
				disk,
			),
		).toEqual([
			"--bind",
			"/h",
			"/h",
			"--bind",
			"/h/.a",
			"/h/.a",
			"--perms",
			"0700",
			"--tmpfs",
			"/h/.a/b",
		]);
	});

	it("pins nothing inside a read-only folder, where nothing moves", () => {
		const args = [
			"--ro-bind",
			"/h",
			"/h",
			"--ro-bind",
			"/h/.a/b/c",
			"/h/.a/b/c",
		];
		expect(pinnedAbove(args, "/h", disk)).toEqual(args);
	});

	it("pins the shallower of two folders first where both go in one place", () => {
		expect(
			pinnedAbove(
				["--bind", "/h", "/h", "--ro-bind", "/h/.a/b/c", "/h/.a/b/c"],
				"/h",
				disk,
			),
		).toEqual([
			"--bind",
			"/h",
			"/h",
			"--bind",
			"/h/.a",
			"/h/.a",
			"--bind",
			"/h/.a/b",
			"/h/.a/b",
			"--ro-bind",
			"/h/.a/b/c",
			"/h/.a/b/c",
		]);
	});

	it("pins a folder before the first mount within it laid after its holder, covering none", () => {
		const within = {
			kind: (path: string) =>
				["/h/.a", "/h/.a/b", "/h/.a/x"].includes(path)
					? ("folder" as const)
					: undefined,
			entries: () => [],
		};
		expect(
			pinnedAbove(
				[
					"--bind",
					"/h",
					"/h",
					"--bind",
					"/h/.a/x",
					"/h/.a/x",
					"--ro-bind",
					"/h/.a/b/c",
					"/h/.a/b/c",
				],
				"/h",
				within,
			),
		).toEqual([
			"--bind",
			"/h",
			"/h",
			"--bind",
			"/h/.a",
			"/h/.a",
			"--bind",
			"/h/.a/x",
			"/h/.a/x",
			"--bind",
			"/h/.a/b",
			"/h/.a/b",
			"--ro-bind",
			"/h/.a/b/c",
			"/h/.a/b/c",
		]);
	});

	it("never binds a link, only the folders around it", () => {
		// /h/.l/s is a link: bubblewrap would bind where it leads.
		const kinds: Record<string, "folder" | "file" | "link"> = {
			"/h/.l": "folder",
			"/h/.l/s": "link",
		};
		const linked = {
			kind: (path: string) => kinds[path],
			entries: () => [],
		};
		expect(
			pinnedAbove(
				[
					"--bind",
					"/h",
					"/h",
					"--ro-bind",
					"/h/.l/s/x",
					"/h/.l/s/x",
					"--ro-bind",
					"/h/.l/s/y",
					"/h/.l/s/y",
				],
				"/h",
				linked,
			),
		).toEqual([
			"--bind",
			"/h",
			"/h",
			"--bind",
			"/h/.l",
			"/h/.l",
			"--ro-bind",
			"/h/.l/s/x",
			"/h/.l/s/x",
			"--ro-bind",
			"/h/.l/s/y",
			"/h/.l/s/y",
		]);
	});

	it("pins above an overlay before its source, never between the two", () => {
		expect(
			pinnedAbove(
				[
					"--bind",
					"/h",
					"/h",
					"--overlay-src",
					"/h/.a/b/c",
					"--tmp-overlay",
					"/h/.a/b/c",
				],
				"/h",
				disk,
			),
		).toEqual([
			"--bind",
			"/h",
			"/h",
			"--bind",
			"/h/.a",
			"/h/.a",
			"--bind",
			"/h/.a/b",
			"/h/.a/b",
			"--overlay-src",
			"/h/.a/b/c",
			"--tmp-overlay",
			"/h/.a/b/c",
		]);
	});

	it("refuses an option it can't read past, rather than leave a folder movable", () => {
		expect(() => pinnedAbove(["--overlay", "/h"], "/h", disk)).toThrow(
			/can't pin past bubblewrap's --overlay/,
		);
	});
});
