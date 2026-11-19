/**
 * What this session's peer says from its quest and its folder: what it
 * works on and owns, its repository, and the groups both put it in.
 */
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	questSharesRoot,
	questWorkspacesRoot,
} from "../../../../lib/internal/quest/workspace/workspace-root.ts";
import { localPeer } from "../../../../lib/mesh/peer.ts";
import { repositoryName } from "../../../../lib/mesh/scope.ts";
import { session, surroundingsAt } from "./support/presences.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-presence-"));
	// Each test's own cache under root, so a folder one test makes is
	// gone before the next, whatever order they run in.
	vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/** Makes quest `id`'s shared folder, as a fenced command's wrap does. */
function sharedOf(id: string): string {
	const folder = join(questSharesRoot(), id);
	mkdirSync(folder, { recursive: true });
	return folder;
}

describe("this session's peer", () => {
	const surroundings = () => surroundingsAt(root);

	it("publishes what its quest says it works on and owns", () => {
		mkdirSync(join(root, "sessions"), { recursive: true });
		writeFileSync(
			join(root, "sessions", `${session}.json`),
			JSON.stringify({ quest: "QEST-20261021-LUQ49E" }),
		);
		mkdirSync(join(root, "quests", "QEST-20261021-LUQ49E"), {
			recursive: true,
		});
		writeFileSync(
			join(root, "quests", "QEST-20261021-LUQ49E", "README.md"),
			"---\nid: QEST-20261021-LUQ49E\nkind: quest\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\n---\n# A Stable Substrate\n\n## 📜 Summary\n\nGrow the mesh.\n\n## 🧭 Purpose\n\nWhy.\n",
		);
		const shared = sharedOf("QEST-20261021-LUQ49E");
		const at = surroundings();

		const peer = localPeer(at);
		peer.join("#harness");

		expect(peer.signature).toBe("LUQ49E");
		expect(at.presences.of(session)).toMatchObject({
			addresses: ["LUQ49E", "24B025FE"],
			groups: ["#harness", "#quest/luq49e"],
			joined: ["#harness"],
			worksOn: "A Stable Substrate: Grow the mesh.",
			owns: expect.arrayContaining(["QEST-20261021-LUQ49E", "harness"]),
		});
		// What the launcher draws, said so it reads no README itself.
		expect(at.presences.of(session)).toMatchObject({
			quest: "QEST-20261021-LUQ49E",
			questInfo: {
				id: "QEST-20261021-LUQ49E",
				title: "A Stable Substrate",
				short: "LUQ49E",
				status: "active",
			},
			cwd: root,
		});
		// Its quest's shared folder, named alike on every machine, so the sessions
		// sharing it form one network.
		expect(at.presences.of(session)?.shares).toEqual([
			{
				key: "quest:qest-20261021-luq49e",
				for: "A Stable Substrate",
				folder: shared,
			},
		]);
	});

	describe("shares its quest's shared folder", () => {
		const quest = "QEST-20261021-LUQ49E";
		const onQuest = (
			heading: string,
			{
				id = quest,
				status = "active",
				made = true,
			}: { id?: string; status?: string; made?: boolean } = {},
		) => {
			if (made) sharedOf(id);
			mkdirSync(join(root, "sessions"), { recursive: true });
			writeFileSync(
				join(root, "sessions", `${session}.json`),
				JSON.stringify({ quest: id }),
			);
			mkdirSync(join(root, "quests", id), { recursive: true });
			writeFileSync(
				join(root, "quests", id, "README.md"),
				`---\nid: ${id}\nkind: quest\nstatus: ${status}\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\n---\n${heading}\n## 📜 Summary\n\nGrow the mesh.\n`,
			);
			const at = surroundingsAt(root);
			const peer = localPeer(at);
			peer.join("#harness");
			return { at, peer };
		};
		const saidFor = (heading: string) =>
			onQuest(heading).at.presences.of(session)?.shares?.[0]?.for;

		it("for its id, when its README has no heading yet, or none a node takes", () => {
			expect(saidFor("")).toBe(quest);
			expect(saidFor("# \u202e"), "a turning mark alone").toBe(quest);
		});

		it("for its heading cut to 120 characters, with no blank left at the end", () => {
			expect(saidFor(`# ${"Long ".repeat(40)}`)).toBe(
				"Long ".repeat(24).trimEnd(),
			);
			expect(
				saidFor(`# a${"😀".repeat(130)}`),
				"each character counted once, never split",
			).toBe(`a${"😀".repeat(119)}`);
		});

		it("for its heading with a tab read as a space and a turning mark dropped, as a node draws it", () => {
			expect(saidFor("# A\tStable\u202e Substrate")).toBe("A Stable Substrate");
			expect(saidFor("# Sta\u200eble"), "dropped, never a space").toBe(
				"Stable",
			);
			expect(
				saidFor(`# ${"a".repeat(119)}\ufeff past the cut`),
				"a byte-order mark at the cut stays, as a node keeps it",
			).toBe(`${"a".repeat(119)}\ufeff`);
			expect(
				saidFor("# A\ufeff  Stable"),
				"only Unicode's blanks run together, as a node trims them",
			).toBe("A\ufeff Stable");
			expect(saidFor("# A\t\u202e Stable"), "and blanks run together").toBe(
				"A Stable",
			);
		});

		it("none from its scratch alone, which holds its TMPDIR and clones", () => {
			mkdirSync(join(questWorkspacesRoot(), quest, "tmp"), {
				recursive: true,
			});
			const said = onQuest("# A Stable Substrate", {
				made: false,
			}).at.presences.of(session);
			expect(said?.questInfo?.id, "its quest was read").toBe(quest);
			expect(said).not.toHaveProperty("shares");
		});

		it("still while its quest is paused or blocked, which aren't sealed", () => {
			for (const status of ["paused", "blocked"]) {
				const said = onQuest("# A Stable Substrate", {
					status,
				}).at.presences.of(session);
				expect(said?.shares, status).toHaveLength(1);
			}
		});

		it("none once its quest is sealed, though its folder is left", () => {
			for (const status of ["concluded", "retired"]) {
				const said = onQuest("# A Stable Substrate", {
					status,
				}).at.presences.of(session);
				expect(said?.questInfo?.status, "its quest was read").toBe(status);
				expect(said, status).not.toHaveProperty("shares");
			}
		});

		it("none while its shared folder is a file, or a link, rather than a folder", () => {
			const shared = join(questSharesRoot(), quest);
			mkdirSync(questSharesRoot(), { recursive: true });
			writeFileSync(shared, "not a folder");
			const said = onQuest("# A Stable Substrate", {
				made: false,
			}).at.presences.of(session);
			expect(said?.questInfo?.id, "its quest was read").toBe(quest);
			expect(said, "a file").not.toHaveProperty("shares");

			rmSync(shared);
			mkdirSync(join(root, "elsewhere"));
			symlinkSync(join(root, "elsewhere"), shared);
			const linked = onQuest("# A Stable Substrate", {
				made: false,
			}).at.presences.of(session);
			expect(linked, "a link to a folder").not.toHaveProperty("shares");
		});

		it("none while the shares' root is a link, as one into the scratches would lead to its scratch", () => {
			mkdirSync(join(questWorkspacesRoot(), quest, "tmp"), {
				recursive: true,
			});
			symlinkSync(questWorkspacesRoot(), questSharesRoot());
			const said = onQuest("# A Stable Substrate", {
				made: false,
			}).at.presences.of(session);
			expect(said?.questInfo?.id, "its quest was read").toBe(quest);
			expect(said).not.toHaveProperty("shares");
		});

		// Root looks into a folder whatever its mode, so there it can't fail.
		it.skipIf(process.getuid?.() === 0)(
			"none while its shared folder can't be looked at, keeping the presence",
			() => {
				// A root of its own that can't be searched, so the folder's own
				// look fails rather than answering.
				const shares = questSharesRoot();
				mkdirSync(join(shares, quest), { recursive: true });
				chmodSync(shares, 0o000);
				try {
					const said = onQuest("# A Stable Substrate", {
						made: false,
					}).at.presences.of(session);
					expect(said?.questInfo?.id, "its quest was read").toBe(quest);
					expect(said, "a folder not to be looked at").not.toHaveProperty(
						"shares",
					);
				} finally {
					chmodSync(shares, 0o700);
				}
			},
		);

		it("still while its session is parked, since it is the quest's to wake", () => {
			const { at, peer } = onQuest("# A Stable Substrate");
			peer.park();
			peer.end();

			const said = at.presences.of(session);
			expect(said, "not ended").not.toHaveProperty("ended");
			expect(said?.shares).toHaveLength(1);
		});

		it("none while its shared folder isn't there yet", () => {
			const said = onQuest("# A Stable Substrate", {
				made: false,
			}).at.presences.of(session);
			expect(said?.questInfo?.id, "its quest was read").toBe(quest);
			expect(said).not.toHaveProperty("shares");
		});

		it("none once its shared folder is gone from under it, read as it looks again", () => {
			const { at, peer } = onQuest("# A Stable Substrate");
			expect(at.presences.of(session)?.shares).toHaveLength(1);

			rmSync(join(questSharesRoot(), quest), { recursive: true });
			peer.refresh();

			expect(at.presences.of(session)).not.toHaveProperty("shares");
			sharedOf(quest);
			peer.refresh();
			expect(at.presences.of(session)?.shares, "again once made").toHaveLength(
				1,
			);
		});

		it("none while its shared folder's path holds a letter a node would clean, since the folder said wouldn't be it", () => {
			vi.stubEnv("XDG_CACHE_HOME", join(root, "ca\u0001che"));
			const said = onQuest("# A Stable Substrate").at.presences.of(session);
			expect(said?.questInfo?.id, "its quest was read").toBe(quest);
			expect(said).not.toHaveProperty("shares");
		});

		// A Mac's paths hold at most 1024 bytes, so no such folder is made there.
		it.skipIf(process.platform === "darwin")(
			"none while its shared folder's path is longer than a node reads",
			() => {
				vi.stubEnv(
					"XDG_CACHE_HOME",
					join(root, ...Array.from({ length: 5 }, () => "c".repeat(220))),
				);
				const said = onQuest("# A Stable Substrate").at.presences.of(session);
				expect(said?.questInfo?.id, "its quest was read").toBe(quest);
				expect(said).not.toHaveProperty("shares");
			},
		);

		it("none while its cache is named relatively, since no other reader would find it", () => {
			const cwd = process.cwd();
			try {
				process.chdir(root);
				vi.stubEnv("XDG_CACHE_HOME", "cache");
				const said = onQuest("# A Stable Substrate").at.presences.of(session);
				expect(said?.questInfo?.id, "its quest was read").toBe(quest);
				expect(said).not.toHaveProperty("shares");
			} finally {
				process.chdir(cwd);
			}
		});

		it("none once its session has ended for good", () => {
			const { at, peer } = onQuest("# A Stable Substrate");
			expect(at.presences.of(session)?.shares).toHaveLength(1);

			peer.end();

			const said = at.presences.of(session);
			expect(said, "its last word said").toHaveProperty("ended");
			expect(said).not.toHaveProperty("shares");
		});

		it("none for an id that names no quest", () => {
			const said = onQuest("# A Plan", {
				id: "PLAN-20261021-LUQ49E",
			}).at.presences.of(session);
			expect(said?.quest, "its claim was read").toBe("PLAN-20261021-LUQ49E");
			expect(said).not.toHaveProperty("shares");
		});

		it("no longer once it leaves its quest", () => {
			const { at, peer } = onQuest("# A Stable Substrate");
			expect(at.presences.of(session)?.shares).toHaveLength(1);

			writeFileSync(join(root, "sessions", `${session}.json`), "{}");
			peer.refresh();

			expect(at.presences.of(session)).not.toHaveProperty("shares");
		});
	});

	it("says its folder and the repository it is a checkout of, on no quest", () => {
		const main = join(root, "core.nix");
		mkdirSync(join(main, ".git"), { recursive: true });
		writeFileSync(
			join(main, ".git", "config"),
			'[remote "origin"]\n\turl = git@github.com:Jitsusama/core.nix.git\n',
		);
		const at = { ...surroundings(), cwd: main };

		localPeer(at);

		const said = at.presences.of(session);
		expect(said).toMatchObject({ cwd: main, repo: "core.nix" });
		expect(said?.questInfo).toBeUndefined();
		expect(said, "no quest, no folder to share").not.toHaveProperty("shares");
	});

	it("owns its worktree's repository by the repository's name", () => {
		// A worktree's folder is named for the tree broker, which no
		// message about the repository ever mentions.
		const main = join(root, "agentic-harness.pi");
		const tree = join(root, "worktree-github-x-agentic-harness.pi-branch");
		mkdirSync(join(main, ".git", "worktrees", "branch"), { recursive: true });
		mkdirSync(tree, { recursive: true });
		writeFileSync(
			join(main, ".git", "config"),
			'[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:Jitsusama/agentic-harness.pi.git\n',
		);
		writeFileSync(
			join(main, ".git", "worktrees", "branch", "commondir"),
			"../..\n",
		);
		writeFileSync(
			join(tree, ".git"),
			`gitdir: ${join(main, ".git", "worktrees", "branch")}\n`,
		);
		mkdirSync(join(root, "plain"));

		expect(repositoryName(tree)).toBe("agentic-harness.pi");
		expect(repositoryName(main)).toBe("agentic-harness.pi");
		expect(repositoryName(join(root, "plain"))).toBe("plain");
	});

	it("is in its quest's group, named down from the root, and its repository's", () => {
		const readme = (id: string, parent: string, trees = "") =>
			`---\nid: ${id}\nkind: subquest\nparent: ${parent}\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\n${trees}---\n# ${id}\n`;
		const checkout = join(root, "agentic-harness.pi");
		mkdirSync(join(checkout, ".git"), { recursive: true });
		// A tree taken away since names no repository: its folder's name
		// is the broker's, not the repository's.
		const gone = join(root, "worktree-github-someone-widget-a-branch");
		const quests: readonly (readonly [id: string, text: string])[] = [
			[
				"QEST-20261021-LUQ49E",
				readme(
					"QEST-20261021-LUQ49E",
					"QEST-20261021-5GV2AH",
					`trees:\n  - path: ${checkout}\n    providerId: git-worktree\n  - path: ${gone}\n    repoRoot: ${gone}\n    providerId: git-worktree\n`,
				),
			],
			[
				"QEST-20261021-5GV2AH",
				readme("QEST-20261021-5GV2AH", "QEST-20261013-4UHC5Q"),
			],
			["QEST-20261013-4UHC5Q", readme("QEST-20261013-4UHC5Q", "null")],
		];
		for (const [id, text] of quests) {
			mkdirSync(join(root, "quests", id), { recursive: true });
			writeFileSync(join(root, "quests", id, "README.md"), text);
		}
		mkdirSync(join(root, "sessions"), { recursive: true });
		writeFileSync(
			join(root, "sessions", `${session}.json`),
			JSON.stringify({ quest: "QEST-20261021-LUQ49E" }),
		);

		const peer = localPeer(surroundings());

		expect(peer.scopes).toEqual([
			"#quest/4uhc5q/5gv2ah/luq49e",
			"#repo/agentic-harness-pi",
		]);
		expect(peer.joined).toEqual([]);
	});

	it("is in the repository it runs in, with no quest", () => {
		const checkout = join(root, "core.nix");
		mkdirSync(join(checkout, ".git"), { recursive: true });
		mkdirSync(join(checkout, "modules"));

		const peer = localPeer({
			...surroundings(),
			cwd: join(checkout, "modules"),
		});

		expect(peer.scopes).toEqual(["#repo/core-nix"]);
	});
});
