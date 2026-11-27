/**
 * Carrying a session's work when the person steers it to: its trees, as
 * the work broker's records hold them for it, and its file, into its
 * quest's handover, through real git.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CarriedContext,
	carryThisSession,
} from "../../../extensions/mesh-workflow/carrying.ts";
import { createTreeMemory } from "../../../lib/core/work/memory.ts";
import {
	handoverOf,
	readHandover,
} from "../../../lib/internal/carry/handover.ts";
import {
	carryUnderWay,
	closeLanded,
} from "../../../lib/internal/carry/under-way.ts";
import { thisMachine } from "../../../lib/internal/machine/machine.ts";
import { sessionRegistryDir } from "../../../lib/internal/quest/sessions/loaded.ts";
import { questWorkspacesRoot } from "../../../lib/internal/quest/workspace/workspace-root.ts";
import { treeRecordDir } from "../../../lib/internal/work-records.ts";
import {
	bareOrigin,
	cloneAt,
	exec,
	folder,
	removeAll,
} from "../../lib/internal/carry/support/machines.ts";

const made: string[] = [];
afterEach(() => {
	// A carried hold stays until its session's close lands, so each test's
	// lets go here rather than lingering in this process for its quarter
	// hour (PV3TE0's round 10, F2).
	for (const id of ["s-carry", "s-closing", "s-stale", "s-whole"])
		closeLanded(id);
	removeAll(made);
});

const QUEST = "QEST-20261107-CARRY2";

/** A session as carrying reads it, idle once `busyFor` looks have passed. */
function session(
	id: string,
	cwd: string,
	file: string,
	busyFor = 0,
): CarriedContext {
	let looks = 0;
	return {
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => file,
			getSessionName: () => "Carry me",
			getCwd: () => cwd,
		} as unknown as CarriedContext["sessionManager"],
		isIdle: () => looks++ >= busyFor,
		hasUI: false,
		ui: {} as CarriedContext["ui"],
	};
}

/** The quest workflow's record of `id` working on `quest`. */
function loaded(id: string, quest: string): void {
	mkdirSync(sessionRegistryDir(), { recursive: true });
	writeFileSync(
		join(sessionRegistryDir(), `${id}.json`),
		JSON.stringify({
			sessionId: id,
			instanceId: "i-1",
			cwd: "/home/joel",
			quest,
			openedAt: "2026-11-07T20:00:00.000Z",
		}),
	);
}

describe("carrying a steered session's work", () => {
	it("puts the trees it holds, its file, its fence and its quest's notes in its quest's handover, once its run ends", async () => {
		const home = folder(made, "home");
		const tree = await cloneAt(
			await bareOrigin(made),
			join(home, "src", "app"),
		);
		createTreeMemory(treeRecordDir()).remember({
			identity: { key: "app-carry", shareable: false },
			path: tree,
			providerId: "git",
			sessions: ["s-carry"],
		});
		loaded("s-carry", QUEST);
		const file = join(folder(made, "sessions"), "2026-11-07_s-carry.jsonl");
		writeFileSync(file, '{"type":"session","id":"s-carry"}\n');

		const done = await carryThisSession(
			session("s-carry", tree, file, 2),
			"penelope",
			{
				home,
				env: { PI_SANDBOX: "fence" },
				notes: async (quest) => [
					{ text: `what ${quest} learned`, tags: ["move"] },
				],
			},
		);

		const into = handoverOf(questWorkspacesRoot(), QUEST, thisMachine());
		expect(done).toBe(join(into, "s-carry.done.json"));
		expect(readHandover(done)).toMatchObject({
			session: "s-carry",
			quest: QUEST,
			cwd: "~/src/app",
			title: "Carry me",
			sessionFile: "2026-11-07_s-carry.jsonl",
			trees: [{ path: "~/src/app", branch: "main" }],
			fence: "fence",
			notes: [{ text: `what ${QUEST} learned`, tags: ["move"] }],
		});
	});

	// PV3TE0's round 7 (F6): a carry that carried let go before its
	// session's close landed, so a second Carry wrote a second handover
	// of work already gone.
	it("turns a second carry away once the first has carried, while its session closes", async () => {
		const home = folder(made, "home");
		loaded("s-closing", QUEST);
		const file = join(folder(made, "sessions"), "2026-11-07_s-closing.jsonl");
		writeFileSync(file, '{"type":"session","id":"s-closing"}\n');
		const carry = () =>
			carryThisSession(session("s-closing", home, file), "penelope", {
				home,
			});

		await carry();

		await expect(carry()).rejects.toThrow(
			"a carry to penelope is already under way.",
		);
	});

	// PV3TE0's round 8 (F11): a stale screen that threw as it named the
	// trees that stayed reported a carry that went as refused.
	it("answers a carry that went, though its screen throws once its done file is written", async () => {
		const home = folder(made, "home");
		// A tree on no branch is skipped, so it stays and is named on
		// screen, which throws.
		const detached = await cloneAt(
			await bareOrigin(made),
			join(home, "src", "detached"),
		);
		await exec("git", ["-C", detached, "checkout", "-q", "--detach"]);
		let asked = 0;
		createTreeMemory(treeRecordDir()).remember({
			identity: { key: "detached-carry", shareable: false },
			path: detached,
			providerId: "git",
			sessions: ["s-stale"],
		});
		loaded("s-stale", QUEST);
		const stale: CarriedContext = {
			...session("s-stale", home, join(home, "none.jsonl")),
			get hasUI(): boolean {
				asked++;
				throw new Error("the context is stale");
			},
		};

		const done = await carryThisSession(stale, "penelope", { home });

		const into = handoverOf(questWorkspacesRoot(), QUEST, thisMachine());
		expect(done).toBe(join(into, "s-stale.done.json"));
		expect(asked, "it reached the stale screen").toBeGreaterThan(0);
	});

	// 1OGSE7's round 000052: a refused tree still wrote the done file,
	// so the node closed the session and the tree's work lost it.
	it("refuses the whole carry when a tree can't go, writing no done file and keeping nothing in the handover", async () => {
		const home = folder(made, "home");
		const tree = await cloneAt(
			await bareOrigin(made),
			join(home, "src", "app"),
		);
		writeFileSync(join(tree, "draft.txt"), "unsaved\n");
		const plain = folder(made, "plain");
		const records = createTreeMemory(treeRecordDir());
		for (const [key, path] of [
			["app-whole", tree],
			["plain-whole", plain],
		] as const) {
			records.remember({
				identity: { key, shareable: false },
				path,
				providerId: "git",
				sessions: ["s-whole"],
			});
		}
		loaded("s-whole", QUEST);
		const file = join(folder(made, "sessions"), "2026-11-23_s-whole.jsonl");
		writeFileSync(file, '{"type":"session","id":"s-whole"}\n');
		const into = handoverOf(questWorkspacesRoot(), QUEST, thisMachine());
		// Whether or not an earlier test made the handover.
		const inHandover = () => (existsSync(into) ? readdirSync(into).sort() : []);
		const before = inHandover();

		await expect(
			carryThisSession(session("s-whole", tree, file), "penelope", { home }),
		).rejects.toThrow(
			`a tree can't go, so nothing was carried:\n${plain}: git couldn't`,
		);

		expect(inHandover()).toEqual(before);
		expect(
			existsSync(join(into, "s-whole.done.json")),
			"no done file is written for a refused carry",
		).toBe(false);
		expect(carryUnderWay("s-whole")).toBeUndefined();
	});

	it("refuses with no quest loaded, having no handover to carry into", async () => {
		const home = folder(made, "home");

		await expect(
			carryThisSession(
				session("s-questless", home, join(home, "none.jsonl")),
				"penelope",
				{
					home,
				},
			),
		).rejects.toThrow("no quest is loaded");
	});

	it("refuses at once, saying why, while it runs code its install left long ago", async () => {
		const home = folder(made, "home");
		const install = folder(made, "install");
		const ago = (version: string, ms: number) => {
			const at = join(install, "versions", version);
			mkdirSync(at, { recursive: true });
			const when = (Date.now() - ms) / 1000;
			utimesSync(at, when, when);
			return at;
		};
		const running = ago(
			"03c16f4cfe6b0b8ed5afba531da67409c1d6729c",
			3 * 86_400_000,
		);
		ago("9255f6d13012e75c85e1b7e9dab118755c1d7f94", 86_400_000);
		symlinkSync(
			join("versions", "9255f6d13012e75c85e1b7e9dab118755c1d7f94"),
			join(install, "current"),
		);

		// A run that never ends, so only a refusal before winding down
		// answers within the test.
		await expect(
			carryThisSession(
				session("s-behind", home, "", Number.POSITIVE_INFINITY),
				"penelope",
				{ home, root: running, windDownMs: 50 },
			),
		).rejects.toThrow("it runs harness 03c16f4cfe6b, which its install left");
		expect(carryUnderWay("s-behind")).toBeUndefined();
	});

	it("gives up when its run never winds down", async () => {
		const home = folder(made, "home");

		await expect(
			carryThisSession(
				session("s-busy", home, "", Number.POSITIVE_INFINITY),
				"penelope",
				{
					home,
					windDownMs: 50,
				},
			),
		).rejects.toThrow("didn't end");
	});
});
