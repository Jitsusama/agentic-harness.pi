/**
 * What a session raises for its person: what waits on him, kept where
 * the launcher reads it and taken up or settled as he acts, and his look
 * list from show_person.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { QUEST_CONCLUDED } from "../../../lib/internal/quest/fields/concluded.ts";
import { SESSION_PROPOSED_CHANGES } from "../../../lib/internal/session/landings.ts";
import { wantsShown } from "../../../lib/internal/session/wants.ts";
import { looksIn } from "../../../lib/mesh/looks/looks.ts";
import {
	keepProposed,
	keptProposed,
	OWN_CHANGE_REFUSED,
	ownChangesBeside,
} from "../../../lib/mesh/looks/own-changes.ts";
import { fixture, onQuest, session, startSession } from "./support/mesh.ts";

describe("what waits on the person", () => {
	it("shows the session's wants while its peer stands, so nothing else notifies", async () => {
		const { fire } = await startSession();
		expect(wantsShown(), "a running session shows its wants").toBe(true);

		await fire("session_shutdown");

		expect(wantsShown(), "a session shut down stops showing its wants").toBe(
			false,
		);
	});

	// 2RCBOJ, 11 November: asks read "session ended" on For You after a
	// new session had taken their quest up.
	it("takes up, as it starts, what an ended session of its quest left waiting", async () => {
		fixture.paths = {
			...fixture.paths,
			waiting: join(fixture.root, "waiting"),
		};
		const file = join(fixture.root, "waiting", "7M6JKG.json");
		mkdirSync(join(fixture.root, "waiting"), { recursive: true });
		const left = {
			id: "eero-login",
			title: "Log in to eero",
			why: "Only Joel has the account",
			minutes: 2,
			window: null,
			quest: "QEST-20261021-7M6JKG",
			ready: true,
			doneWhen: { by: "person" },
			steps: ["Open the eero app"],
			owner: { session: "gone-session", address: "WJATIN", state: "ended" },
		};
		writeFileSync(
			file,
			JSON.stringify({ v: 2, updated: "x", quest: left.quest, items: [left] }),
		);

		await startSession();

		const owner = JSON.parse(readFileSync(file, "utf8")).items[0]?.owner;
		expect(owner?.session, "the session now running owns it").toBe(session);
		expect(owner?.state, "it no longer reads ended").toBeUndefined();
	});

	it("wakes an idle session once the person does what it raised, and not for its own settling", async () => {
		// A session that ended its run Blocked on the person had nothing to
		// wake it once he acted: verdicts were read only as a run began or ended.
		fixture.paths = {
			...fixture.paths,
			waiting: join(fixture.root, "waiting"),
		};
		const { sent, tools } = await startSession(
			{},
			{ isIdle: () => true },
			[],
			undefined,
			20,
		);
		const wait = (params: Record<string, unknown>) =>
			tools.get("mesh_wait")?.execute("call-w", params);
		const raise = (id: string, title: string) =>
			wait({
				id,
				title,
				why: "Only Joel has the account",
				minutes: 2,
				doneWhen: { by: "person" },
				steps: ["Open the app", "Sign in"],
			});
		const told = () =>
			sent.filter((one) =>
				String(one.message.content).startsWith("No longer waiting"),
			);

		await raise("eero-login", "Log in to eero");
		await raise("router-look", "Look at the router");
		// Settled by this session itself: nothing to tell it.
		await wait({ id: "router-look", done: true });
		writeFileSync(
			join(fixture.root, "verdicts.json"),
			JSON.stringify({
				v: 1,
				updated: new Date().toISOString(),
				items: {
					"QEST-20261021-7M6JKG:eero-login": {
						state: "done",
						at: new Date().toISOString(),
					},
				},
			}),
		);

		// Had its own settling been told, it would come first, alone.
		await vi.waitFor(() => expect(told()).toHaveLength(1));
		expect(told()[0]).toEqual({
			message: expect.objectContaining({
				content:
					"No longer waiting on the person: eero-login (Log in to eero). The desktop found it done, or the person cleared it. Carry on with what waited on it.",
			}),
			options: { triggerTurn: true },
		});
	});

	it("says a fenced session's item is strict, so the daemon won't run its check", async () => {
		// The daemon runs a check as the person; run for a fenced session, it
		// would let the session's command out of its fence.
		vi.stubEnv("PI_SANDBOX", "strict");
		try {
			fixture.paths = {
				...fixture.paths,
				waiting: join(fixture.root, "waiting"),
			};
			const { tools } = await startSession();
			await tools.get("mesh_wait")?.execute("call-w", {
				id: "look",
				title: "Look at the router",
				why: "Only Joel is home",
				minutes: 1,
				doneWhen: { check: "router-up" },
				steps: ["Look at its light"],
			});
			const kept = JSON.parse(
				readFileSync(join(fixture.root, "waiting", "7M6JKG.json"), "utf8"),
			);
			expect(kept.items[0].owner).toEqual({
				session,
				address: expect.any(String),
				sandbox: "strict",
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

// Joel, 11 November: what fights for his attention carries its own
// context, and disappears once it no longer applies.
describe("the person's look list, from show_person", () => {
	const pr = {
		kind: "pr",
		target: "https://github.com/Jitsusama/agentic-harness.pi/pull/1378",
		title: "The status bar at narrow widths",
		happened:
			"Your status bar keeps the model, the cost and the branch at 76 columns.",
		matters:
			"It showed only the folder there, so you couldn't see what a session cost.",
		act: "Try the Bar",
		choices: ["Keep It", "Roll It Back"],
		follows: ["It stays as it is.", "I put the old bar back tonight."],
	};

	it("keeps what he is asked, and refuses a look written in the agents' talk", async () => {
		onQuest();
		fixture.paths = { ...fixture.paths, looks: join(fixture.root, "looks") };
		const { tools } = await startSession();
		const show = (params: Record<string, unknown>) =>
			tools.get("show_person")?.execute("call-s", params);

		const talk = await show({
			...pr,
			matters: "Settled with WCJQSG in [4a4ae257].",
		});
		expect(talk?.content[0]?.text, "agent talk").toContain("can't place");
		const terse = await show({ ...pr, act: undefined });
		expect(terse?.content[0]?.text, "no act").toContain("its act");
		const firstForm = await show({
			kind: pr.kind,
			target: pr.target,
			title: pr.title,
			why: "It keeps the model now.",
			ask: "Keep it?",
		});
		// The tool takes no why or ask, so a first form is refused for
		// want of what happened, never as both forms at once.
		expect(firstForm?.content[0]?.text, "why and ask alone").toContain(
			"what happened",
		);
		expect(looksIn(join(fixture.root, "looks")), "neither was kept").toEqual(
			[],
		);

		await show(pr);
		expect(looksIn(join(fixture.root, "looks"))[0]).toMatchObject({
			happened: pr.happened,
			matters: pr.matters,
			act: pr.act,
			ask: "Try the Bar: Keep It, or Roll It Back.",
			quest: "QEST-20261021-7M6JKG",
			state: "waiting",
		});
	});

	it("refuses a look at a change the session proposed, and keeps one it didn't", async () => {
		onQuest();
		fixture.paths = { ...fixture.paths, looks: join(fixture.root, "looks") };
		const { tools } = await startSession();
		const branch = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "review_offer",
					details: { ok: true, url: pr.target },
				},
			},
		];
		const ctx = { sessionManager: { getBranch: () => branch } };
		const show = (params: Record<string, unknown>) =>
			tools
				.get("show_person")
				?.execute("call-s", params, undefined, undefined, ctx);

		const own = await show(pr);
		const itsDiff = await show({
			...pr,
			kind: "diff",
			target: `${pr.target}/files`,
		});

		const asPage = await show({ ...pr, kind: "page", act: "Just See" });

		for (const refused of [own, itsDiff, asPage]) {
			expect(refused?.content[0]?.text).toBe(
				`⊘ ${OWN_CHANGE_REFUSED} Nothing was added.`,
			);
		}
		expect(looksIn(join(fixture.root, "looks")), "none was kept").toEqual([]);
		await show({ ...pr, target: "https://github.com/o/r/pull/9" });
		expect(looksIn(join(fixture.root, "looks"))).toHaveLength(1);
	});

	// Joel, 24 November: a hosted conversation keeps only what came after
	// its last compaction, so a session's own record of #2188 was gone
	// when it put #2188 on his list. The host still knows who wrote it.
	it("refuses a change his own account wrote, though nothing kept its proposal", async () => {
		onQuest();
		fixture.paths = { ...fixture.paths, looks: join(fixture.root, "looks") };
		const { tools, whoWrote } = await startSession();
		const asked: string[] = [];
		whoWrote((url) => {
			asked.push(url);
			return url.includes("/pull/1378")
				? { by: "signed-in", author: "Jitsusama" }
				: { by: "other", author: "someone" };
		});
		const show = (params: Record<string, unknown>) =>
			tools.get("show_person")?.execute("call-s", params);

		const own = await show({ ...pr, kind: "page", act: "Just See" });
		await show({ ...pr, target: "https://github.com/o/r/pull/9" });

		expect(own?.content[0]?.text).toMatch(
			/^⊘ Jitsusama wrote that change, the account every one of the person's sessions proposes under\. .* Nothing was added\.$/,
		);
		expect(asked, "the host was asked of each").toEqual([
			pr.target,
			"https://github.com/o/r/pull/9",
		]);
		expect(
			looksIn(join(fixture.root, "looks")).map((look) => look.target),
			"someone else's change goes up",
		).toEqual(["https://github.com/o/r/pull/9"]);
	});

	it("refuses a change whose host can't say who wrote it", async () => {
		onQuest();
		fixture.paths = { ...fixture.paths, looks: join(fixture.root, "looks") };
		const { tools, whoWrote } = await startSession();
		whoWrote(() => ({ by: "unknown", why: "the host is down" }));

		const refused = await tools.get("show_person")?.execute("call-s", pr);

		expect(refused?.content[0]?.text).toContain("(the host is down)");
		expect(looksIn(join(fixture.root, "looks"))).toEqual([]);
	});

	it("asks no host of a file", async () => {
		onQuest();
		fixture.paths = { ...fixture.paths, looks: join(fixture.root, "looks") };
		const { tools, whoWrote } = await startSession();
		const asked: string[] = [];
		whoWrote((url) => {
			asked.push(url);
			return { by: "no-change" };
		});

		await tools.get("show_person")?.execute("call-s", {
			...pr,
			kind: "file",
			target: join(fixture.root, "notes.md"),
			act: "Just See",
			choices: [],
			follows: [],
		});

		expect(asked).toEqual([]);
		expect(looksIn(join(fixture.root, "looks"))).toHaveLength(1);
	});

	// A rollover starts a log without the review_offer answers, and a
	// codemode proposal never puts one there: what the bus said is kept.
	it("refuses a change its quest proposed, though the log no longer names it", async () => {
		onQuest();
		fixture.paths = { ...fixture.paths, looks: join(fixture.root, "looks") };
		const { emit, tools } = await startSession();
		const show = (params: Record<string, unknown>) =>
			tools.get("show_person")?.execute("call-s", params);

		emit(SESSION_PROPOSED_CHANGES, { urls: [pr.target] });
		const refused = await show({
			...pr,
			target: `${pr.target.replace("Jitsusama", "jitsusama")}.diff`,
			kind: "diff",
		});

		expect(refused?.content[0]?.text).toBe(
			`⊘ ${OWN_CHANGE_REFUSED} Nothing was added.`,
		);
		expect(
			keptProposed(ownChangesBeside(join(fixture.root, "looks")), [
				"QEST-20261021-7M6JKG",
			]),
			"kept under its quest, for the sessions after it",
		).toEqual([pr.target]);
		expect(looksIn(join(fixture.root, "looks"))).toEqual([]);
	});

	// What another session of the quest proposed is kept under the quest
	// alone, so this session's own log and record say nothing of it.
	it("refuses a change another session of its quest proposed", async () => {
		onQuest();
		fixture.paths = { ...fixture.paths, looks: join(fixture.root, "looks") };
		const { tools } = await startSession();
		keepProposed(
			ownChangesBeside(join(fixture.root, "looks")),
			"QEST-20261021-7M6JKG",
			[pr.target],
		);

		const refused = await tools
			.get("show_person")
			?.execute("call-s", { ...pr, kind: "page", act: "Just See" });

		expect(refused?.content[0]?.text).toBe(
			`⊘ ${OWN_CHANGE_REFUSED} Nothing was added.`,
		);
		expect(looksIn(join(fixture.root, "looks"))).toEqual([]);
	});

	it("takes a look back when its session says it no longer applies", async () => {
		onQuest();
		fixture.paths = { ...fixture.paths, looks: join(fixture.root, "looks") };
		const { tools } = await startSession();
		const show = (params: Record<string, unknown>) =>
			tools.get("show_person")?.execute("call-s", params);
		await show(pr);

		const taken = await show({
			kind: pr.kind,
			target: pr.target,
			withdraw: true,
		});

		expect(taken?.content[0]?.text).toContain("Taken back");
		expect(looksIn(join(fixture.root, "looks"))[0]).toMatchObject({
			state: "resolved",
			how: "taken back",
		});
		const again = await show({
			kind: pr.kind,
			target: pr.target,
			withdraw: true,
		});
		expect(again?.content[0]?.text).toContain("Nothing to take back");
	});

	// WCJQSG, 12 November: a look that asks nothing back is gone once seen,
	// and one quest's looks at one thing are one look.
	it("says a look that only shows leaves once seen, and folds looks on one thread", async () => {
		onQuest();
		fixture.paths = { ...fixture.paths, looks: join(fixture.root, "looks") };
		const { tools } = await startSession();
		const show = (params: Record<string, unknown>) =>
			tools.get("show_person")?.execute("call-s", params);

		const shown = await show({
			...pr,
			act: "Just See",
			choices: [],
			follows: [],
			thread: "the bar",
		});
		await show({
			...pr,
			kind: "page",
			target: "https://example.com/bar",
			thread: "the bar",
		});

		expect(shown?.content[0]?.text, "what it says of a showing look").toContain(
			"leaves once they open it",
		);
		expect(
			looksIn(join(fixture.root, "looks")).map((look) => look.target),
			"the later look on the thread in its place",
		).toEqual(["https://example.com/bar"]);
	});

	it("resolves the looks of a quest as it ends, and leaves another's", async () => {
		onQuest();
		fixture.paths = { ...fixture.paths, looks: join(fixture.root, "looks") };
		const { tools, emit } = await startSession();
		await tools.get("show_person")?.execute("call-s", pr);

		emit(QUEST_CONCLUDED, {
			how: "concluded",
			ids: ["QEST-20261021-5GV2AH"],
			said: "Concluded.",
		});
		expect(
			looksIn(join(fixture.root, "looks"))[0]?.state,
			"another quest's ending",
		).toBe("waiting");

		emit(QUEST_CONCLUDED, {
			how: "concluded",
			ids: ["QEST-20261021-7M6JKG"],
			said: "Concluded.",
		});
		expect(looksIn(join(fixture.root, "looks"))[0]).toMatchObject({
			state: "resolved",
			how: "its quest ended",
		});
	});
});
