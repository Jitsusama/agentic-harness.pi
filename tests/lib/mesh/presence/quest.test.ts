/**
 * What this session's peer says from its quest and its folder: what it
 * works on and owns, its repository, and the groups both put it in.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localPeer } from "../../../../lib/mesh/peer.ts";
import { repositoryName } from "../../../../lib/mesh/scope.ts";
import { session, surroundingsAt } from "./support/presences.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-presence-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

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
