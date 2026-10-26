/**
 * Presence: what a peer publishes, where it is kept, and what this
 * session's own peer says about itself.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localPeer } from "../../../lib/mesh/peer.ts";
import {
	createPresences,
	type Presence,
	repositoryName,
	windowTitle,
} from "../../../lib/mesh/presence.ts";

let root: string;
const session = "01a15f3a-2255-7463-9909-afa624b025fe";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-presence-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const presence = (over: Partial<Presence> = {}): Presence => ({
	session: "s-1",
	addresses: ["7M6JKG"],
	groups: ["#harness"],
	worksOn: "the mesh",
	owns: ["harness"],
	busy: false,
	at: "2026-10-21T22:00:00.000Z",
	...over,
});

describe("presences", () => {
	it("keep a peer's presence by its session id", () => {
		createPresences(root).publish(presence());

		expect(createPresences(root).of("s-1")).toEqual(presence());
		expect(createPresences(root).of("s-2")).toBeUndefined();
	});

	it("list every peer, passing over one that will not read", () => {
		const presences = createPresences(root);
		presences.publish(presence());
		presences.publish(presence({ session: "s-2", addresses: ["B"] }));
		writeFileSync(join(root, "torn.json"), "{", "utf8");

		expect(
			presences
				.all()
				.map((one) => one.session)
				.sort(),
		).toEqual(["s-1", "s-2"]);
	});
});

describe("this session's peer", () => {
	const surroundings = () => ({
		session,
		cwd: root,
		records: { sessions: join(root, "sessions"), quests: join(root, "quests") },
		presences: createPresences(join(root, "presence")),
	});

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
			`---\nid: QEST-20261021-LUQ49E\nkind: quest\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\n---\n# A Stable Substrate\n\n## 📜 Summary\n\nGrow the mesh.\n\n## 🧭 Purpose\n\nWhy.\n`,
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

	it("publishes only when something in its presence changed", () => {
		// Presence follows events, never a clock: a peer at rest writes nothing.
		const kept = createPresences(join(root, "presence"));
		const written: Presence[] = [];
		const presences = {
			...kept,
			publish: (one: Presence) => {
				written.push(one);
				kept.publish(one);
			},
		};
		const peer = localPeer({ ...surroundings(), presences });

		peer.refresh();
		peer.refresh();
		peer.setBusy(false);
		expect(written).toHaveLength(1);
		peer.setBusy(true);
		expect(written.map((one) => one.busy)).toEqual([false, true]);
		expect(kept.of(session)).toMatchObject({ busy: true });
	});

	it("says its window's title as pi sets it, and the new one after a rename", () => {
		// The desktop finds a peer's window by this exact title, since the
		// title itself no longer carries an address.
		let name: string | undefined;
		const at = {
			...surroundings(),
			title: () => windowTitle(name, "/home/someone/src/core.nix"),
		};
		const peer = localPeer(at);
		expect(at.presences.of(session)?.title).toBe("\u03c0 - core.nix");

		name = "Agentic loop";
		peer.setBusy(true);

		expect(at.presences.of(session)?.title).toBe(
			"\u03c0 - Agentic loop - core.nix",
		);
		expect(createPresences(join(root, "presence")).of(session)?.title).toBe(
			"\u03c0 - Agentic loop - core.nix",
		);
	});

	it("is in its quest's group, named down from the root, and its repository's", () => {
		const readme = (id: string, parent: string, trees = "") =>
			`---\nid: ${id}\nkind: subquest\nparent: ${parent}\nstatus: active\npriority: active\nrank: 1\nstarted: 2026-10-21\nupdated: 2026-10-21\n${trees}---\n# ${id}\n`;
		const checkout = join(root, "agentic-harness.pi");
		mkdirSync(join(checkout, ".git"), { recursive: true });
		// A tree taken away since names no repository: its folder's name
		// is the broker's, not the repository's.
		const gone = join(root, "worktree-github-someone-widget-a-branch");
		for (const [id, text] of [
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
		]) {
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

	it("keeps only what it joined across a reload, and works its scopes out again", () => {
		const at = surroundings();
		at.presences.publish(
			presence({
				session,
				groups: ["#harness", "#quest/old"],
				joined: ["#harness"],
			}),
		);

		const again = localPeer(at);

		expect(again.groups).toEqual(["#harness"]);
	});

	it("keeps its groups across a reload", () => {
		const first = localPeer(surroundings());
		first.join("#optimus/power");

		const again = localPeer(surroundings());

		expect(again.groups).toEqual(["#optimus/power"]);
		expect(again.leave("#optimus/power")).toBe(true);
		expect(again.leave("#optimus/power")).toBe(false);
	});

	it("keeps its stops across a reload, until it lifts them", () => {
		const stop = { address: "P9R1KI", session: "s-p", at: "2026-10-22" };
		const first = localPeer(surroundings());
		expect(first.stop(stop)).toBe(true);
		expect(first.stop({ ...stop, why: "again" })).toBe(false);

		const again = localPeer(surroundings());

		expect(again.stops).toEqual([stop]);
		expect(surroundings().presences.of(session)?.stops).toEqual([stop]);
		expect(again.lift("P9R1KI")).toEqual(stop);
		expect(again.lift("P9R1KI")).toBeUndefined();
		expect(localPeer(surroundings()).stops).toEqual([]);
		expect(surroundings().presences.of(session)?.stops).toBeUndefined();
	});

	it("says what it waits on its person for, longest first, until each is settled", () => {
		const peer = localPeer(surroundings());
		const asked = {
			kind: "question" as const,
			since: "2026-10-22T08:00:00.000Z",
			said: "Which launcher?",
		};
		const held = {
			kind: "approval" as const,
			since: "2026-10-22T07:50:00.000Z",
			said: "Push to main?",
		};
		const kept = () => surroundings().presences.of(session)?.wants;

		peer.want(asked);
		expect(kept()).toEqual(asked);
		peer.want(held);
		expect(kept()).toEqual(held);
		expect(peer.settle("approval")).toBe(true);
		expect(kept()).toEqual(asked);
		expect(peer.settle("approval")).toBe(false);
		expect(peer.settle("question")).toBe(true);
		expect(kept()).toBeUndefined();
	});

	it("waits on nothing after a start, whatever its presence said", () => {
		const peer = localPeer(surroundings());
		peer.want({
			kind: "blocked",
			since: "2026-10-22T08:00:00.000Z",
			said: "Blocked: needs Joel's say on the launcher",
		});

		const again = localPeer(surroundings());

		expect(again.wants).toBeUndefined();
		expect(surroundings().presences.of(session)?.wants).toBeUndefined();
	});
});
