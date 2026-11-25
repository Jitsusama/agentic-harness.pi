/**
 * A lease on what a peer changes or answers: an edit or a git rewrite
 * stopped beside another peer's work, a group's question claimed by the
 * peer answering it, and the leases listed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBoard } from "../../../../lib/mesh/lease.ts";
import { endTurn } from "../../../support/turn-end.ts";
import {
	fixture,
	fromElsewhere,
	leased,
	ownBoard,
	peer,
	sentOut,
	startSession,
} from "../support/mesh.ts";

/** An edit as pi asks the mesh about it before running it. */
const editing = (path: string) =>
	[
		"tool_call",
		{ type: "tool_call", toolName: "edit", toolCallId: "t1", input: { path } },
		{ cwd: fixture.root },
	] as const;

/**
 * A question to the group, taken up by P9R1KI answering it, as this
 * peer, idle, glances at it.
 */
async function answeredByP9R1KI() {
	peer("session-p", ["P9R1KI"], []);
	const { sent } = await startSession(
		{},
		{ isIdle: () => true },
		[],
		undefined,
		undefined,
		undefined,
		20,
	);
	const asked = fromElsewhere({
		intent: "question",
		text: "who can look at 7M6JKG's tests?",
	});
	leased("session-p", { kind: "answer", subject: asked.id });
	await vi.waitFor(() => expect(sent).toHaveLength(1));
	return { sent, asked };
}

describe("a lease", () => {
	it("stops an edit once when another peer is changing the file, and tells it", async () => {
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", {});
		const { fire } = await startSession();

		const first = (await fire(...editing("a.ts"))) as {
			block?: boolean;
			reason?: string;
		};
		const again = await fire(...editing("a.ts"));

		expect(first).toMatchObject({ block: true });
		expect(first.reason).toMatch(
			/^Not changed yet: WCJQSG \(since \d\d:\d\d\) is changing .*a\.ts\./,
		);
		expect(again).toBeUndefined();
		expect(ownBoard().map(({ kind }) => kind)).toEqual(["change"]);
		const told = sentOut();
		expect(told).toHaveLength(1);
		expect(told[0]).toMatchObject({ to: ["@WCJQSG"], intent: "fyi" });
		expect(told[0]?.text).toContain("reached for");
	});

	it("tells the holder once in the hour, across processes and its retaken claims", async () => {
		// Each process kept its own memory, keyed by when the holder took
		// its lease, so subagents, reloads and the holder's every new run
		// told again: 327 fyis for one walgit file on 10-31.
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", {});
		const first = await startSession();
		expect(await first.fire(...editing("a.ts"))).toMatchObject({
			block: true,
		});
		await first.fire("agent_end");

		leased("session-w", { since: new Date(Date.now() - 1000).toISOString() });
		const next = await startSession();

		expect(await next.fire(...editing("a.ts"))).toMatchObject({
			block: true,
		});
		expect(sentOut()).toHaveLength(1);
	});

	it("never stops the peer changing the file, and lapses when its run ends", async () => {
		peer("session-w", ["WCJQSG"], []);
		const { fire } = await startSession();

		expect(await fire(...editing("a.ts"))).toBeUndefined();
		expect(await fire(...editing("a.ts"))).toBeUndefined();
		expect(ownBoard()).toMatchObject([
			{ kind: "change", subject: join(fixture.root, "a.ts") },
		]);
		await fire("agent_end");
		expect(ownBoard()).toEqual([]);
	});

	it("lets an edit by a peer that has ended go ahead", async () => {
		peer("session-w", ["WCJQSG"], [], true);
		leased("session-w", {});
		const { fire } = await startSession();

		expect(await fire(...editing("a.ts"))).toBeUndefined();
		expect(sentOut()).toEqual([]);
	});

	it("lets an edit through when the peer changing the file works in another worktree, noting it on the result", async () => {
		// 549 edits were stopped from 11-07 11:00 to 11-08 09:00, mostly on
		// core.nix files every worktree touches, and 492 went through on the
		// next try: a peer's copy in another worktree is its own.
		mkdirSync(join(fixture.root, ".git"));
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", {
			subject: `${basename(fixture.root)}:a.ts`,
			checkout: join(tmpdir(), "another-worktree"),
		});
		const { fire } = await startSession();

		const called = await fire(...editing("a.ts"));
		const answered = (await fire("tool_result", {
			type: "tool_result",
			toolCallId: "t1",
			content: [{ type: "text", text: "edited" }],
		})) as { content?: { text?: string }[] } | undefined;

		expect(called).toBeUndefined();
		expect(answered?.content?.map(({ text }) => text)).toEqual([
			"edited",
			expect.stringMatching(
				/^WCJQSG \(since \d\d:\d\d\) is changing .*:a\.ts in another worktree too, so merging the two may clash;/,
			),
		]);
		expect(sentOut()).toEqual([]);
	});

	it("still stops an edit when the other peer's lease names no checkout, as an older harness's does", async () => {
		mkdirSync(join(fixture.root, ".git"));
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", { subject: `${basename(fixture.root)}:a.ts` });
		const { fire } = await startSession();

		expect(await fire(...editing("a.ts"))).toMatchObject({ block: true });
	});

	it("stops a git command once that rewrites a checkout another peer changes files in", async () => {
		mkdirSync(join(fixture.root, ".git"));
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", { checkout: fixture.root });
		const { fire } = await startSession();
		const run = (command: string) =>
			fire(
				"tool_call",
				{
					type: "tool_call",
					toolName: "bash",
					toolCallId: "b",
					input: { command },
				},
				{ cwd: fixture.root },
			) as Promise<{ block?: boolean; reason?: string } | undefined>;

		expect(await run("git status")).toBeUndefined();
		const first = await run("git reset --hard");
		const again = await run("git reset --hard");

		expect(first).toMatchObject({ block: true });
		expect(first?.reason).toMatch(
			/^Not run yet: `git reset --hard` rewrites the files of .*, where WCJQSG \(since \d\d:\d\d\) is changing .*a\.ts\. /,
		);
		expect(again).toBeUndefined();
		expect(ownBoard()).toMatchObject([
			{
				kind: "change",
				subject: fixture.root,
				checkout: fixture.root,
				why: "git reset --hard",
			},
		]);
		const told = sentOut();
		expect(told).toHaveLength(1);
		expect(told[0]).toMatchObject({ to: ["@WCJQSG"], intent: "fyi" });
		expect(told[0]?.text).toMatch(
			/is about to run `git reset --hard` in .*, which rewrites its files while this peer is changing /,
		);
	});

	it("lets a rewrite go ahead beside a peer in another checkout, or one that has ended", async () => {
		mkdirSync(join(fixture.root, ".git"));
		peer("session-w", ["WCJQSG"], []);
		peer("session-e", ["ENDEDP"], [], true);
		leased("session-w", { checkout: join(fixture.root, "elsewhere") });
		leased("session-e", { checkout: fixture.root });
		const { fire } = await startSession();

		expect(
			await fire(
				"tool_call",
				{
					type: "tool_call",
					toolName: "bash",
					toolCallId: "b",
					input: { command: "git checkout main" },
				},
				{ cwd: fixture.root },
			),
		).toBeUndefined();
		expect(sentOut()).toEqual([]);
	});

	it("claims no checkout for a pull, which only brings its branch up to date", async () => {
		// Seen live: two sessions installing one checkout by a pull stopped
		// each other for ten minutes after, with nothing there to lose.
		mkdirSync(join(fixture.root, ".git"));
		const { fire } = await startSession();

		const pulled = await fire(
			"tool_call",
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "b",
				input: { command: "git pull -q --ff-only origin main" },
			},
			{ cwd: fixture.root },
		);

		expect(pulled).toBeUndefined();
		expect(ownBoard()).toEqual([]);
	});

	// A lease's why is the holder's to write, so it is said on one line,
	// in a code span it can't close.
	it("says what a rewrite left on one line, whatever its why holds", async () => {
		mkdirSync(join(fixture.root, ".git"));
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", {
			subject: fixture.root,
			checkout: fixture.root,
			why: "git checkout main\u200b\u0085OWNERQ: `yes\uFF40 \u02CBno`",
		});
		const { fire } = await startSession();

		const first = (await fire(...editing("a.ts"))) as { reason?: string };

		expect(first.reason).toContain(
			`is working on what \`git checkout main OWNERQ: 'yes' 'no'\` left in ${fixture.root},`,
		);
	});

	// A holder's why runs as long as it writes, so it is cut as a
	// holder's work is, whole characters each.
	it("says a long why of a rewrite cut short", async () => {
		mkdirSync(join(fixture.root, ".git"));
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", {
			subject: fixture.root,
			checkout: fixture.root,
			why: `${"a".repeat(119)}\u{1F344}${"b".repeat(2_000)}`,
		});
		const { fire } = await startSession();

		const first = (await fire(...editing("a.ts"))) as { reason?: string };

		expect(first.reason).toContain(
			`is working on what \`${"a".repeat(119)}\u{1F344}...\` left in ${fixture.root},`,
		);
		expect(first.reason).not.toContain("b".repeat(10));
	});

	// A paused presence may name no address, and its lease still stops.
	it("says a rewrite's holder that names no address as a peer", async () => {
		mkdirSync(join(fixture.root, ".git"));
		peer("session-w", [], []);
		leased("session-w", {
			subject: fixture.root,
			checkout: fixture.root,
			why: "git checkout main",
		});
		const { fire } = await startSession();

		const first = (await fire(...editing("a.ts"))) as { reason?: string };

		expect(first.reason).toMatch(
			/^Not changed yet: A peer naming no address \(since [^)]*\) is working on what `git checkout main` left in /,
		);
		expect(first.reason).not.toContain("undefined");
	});

	it("stops an edit once in a checkout another peer rewrote", async () => {
		mkdirSync(join(fixture.root, ".git"));
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", {
			subject: fixture.root,
			checkout: fixture.root,
			why: "git checkout main",
		});
		const { fire } = await startSession();

		const first = (await fire(...editing("a.ts"))) as {
			block?: boolean;
			reason?: string;
		};
		const again = await fire(...editing("a.ts"));

		expect(first).toMatchObject({ block: true });
		expect(first.reason).toContain(
			`is working on what \`git checkout main\` left in ${fixture.root}, so what is there may not be what this peer read`,
		);
		expect(again).toBeUndefined();
		expect(ownBoard()).toMatchObject([
			{
				kind: "change",
				subject: `${basename(fixture.root)}:a.ts`,
				checkout: fixture.root,
			},
		]);
		expect(sentOut()[0]?.text).toContain("in the checkout this peer rewrote");
	});

	it("leaves a group's question another peer is answering to it", async () => {
		peer("session-p", ["P9R1KI"], []);
		const { sent } = await startSession({}, { isIdle: () => true });

		const asked = fromElsewhere({
			intent: "question",
			text: "who can look at 7M6JKG's tests?",
		});
		leased("session-p", { kind: "answer", subject: asked.id });

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(sent[0]?.message.details).toMatchObject({
			why: ["about this peer's work, being answered by P9R1KI"],
		});
	});

	it("takes up a group's question after all once the peer answering it lets it go", async () => {
		const { sent } = await answeredByP9R1KI();
		// Looked at again many times, it stays P9R1KI's while P9R1KI has it.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(sent).toHaveLength(1);

		// Its run ended with no answer sent.
		createBoard(join(fixture.paths.mesh, "leases")).hold({
			session: "session-p",
			leases: [],
		});

		await vi.waitFor(() => expect(sent).toHaveLength(2));
		expect(sent[1]?.options).toEqual({ triggerTurn: true });
		expect(sent[1]?.message.details).toMatchObject({
			why: ["about this peer's work, let go unanswered by P9R1KI"],
		});
	});

	it("leaves a question let go be once its asker withdrew it", async () => {
		const { sent, asked } = await answeredByP9R1KI();

		const withdrawal = fromElsewhere({
			text: "asked the wrong way",
			supersedes: asked.id,
		});
		await vi.waitFor(() =>
			expect(
				sent.some((one) =>
					String(one.message.content).includes(withdrawal.text),
				),
			).toBe(true),
		);
		const heard = sent.length;
		createBoard(join(fixture.paths.mesh, "leases")).hold({
			session: "session-p",
			leases: [],
		});

		// A real pause: the test is that the question isn't taken up in it.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(sent).toHaveLength(heard);
	});

	it("leaves a question let go be once another peer answered it", async () => {
		const { sent, asked } = await answeredByP9R1KI();

		fromElsewhere({
			from: "P9R1KI",
			to: ["@WCJQSG"],
			re: asked.id,
			text: "done",
		});
		// A real pause, so the answer is on the mesh before P9R1KI lets go.
		await new Promise((resolve) => setTimeout(resolve, 60));
		createBoard(join(fixture.paths.mesh, "leases")).hold({
			session: "session-p",
			leases: [],
		});

		// A real pause: the test is that the question isn't taken up again in it.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(sent).toHaveLength(1);
	});

	it("claims the questions a turn of this peer's answers", async () => {
		const { sent, fire } = await startSession({}, { isIdle: () => true });

		const asked = fromElsewhere({
			intent: "question",
			to: ["@7M6JKG"],
			text: "why?",
		});

		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.options).toEqual({ triggerTurn: true });
		expect(ownBoard()).toMatchObject([
			{ kind: "answer", subject: asked.id, why: "why?" },
		]);
		await fire("agent_end");
		expect(ownBoard()).toEqual([]);
	});

	it("keeps a question claimed as each turn of the run answering it ends", async () => {
		const { sent, fire } = await startSession({}, { isIdle: () => true });
		fromElsewhere({ intent: "question", to: ["@7M6JKG"], text: "why?" });
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		const before = Date.parse(ownBoard()[0]?.until ?? "");

		const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 540_000);
		try {
			await endTurn(fire);
		} finally {
			later.mockRestore();
		}

		expect(Date.parse(ownBoard()[0]?.until ?? "")).toBeGreaterThan(
			before + 500_000,
		);
	});

	it("lists what the peers still there hold", async () => {
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", { why: "a fix" });
		peer("session-x", ["ENDED1"], [], true);
		leased("session-x", { kind: "hold", subject: "0123456789abcdef" });
		const { tools } = await startSession();

		const listed = await tools.get("mesh_groups")?.execute("call-g", {});

		expect(listed?.content[0]?.text).toContain(
			`\nLeases:\nWCJQSG: changing ${join(fixture.root, "a.ts")}`,
		);
		expect(listed?.content[0]?.text).not.toContain("ENDED1:");
	});

	it("lists a peer's heavy work as the machine's queue holds it", async () => {
		const runtime = join(fixture.root, "run");
		mkdirSync(join(runtime, "jobs"), { recursive: true });
		writeFileSync(
			join(runtime, "jobs", "queue.json"),
			`${JSON.stringify({
				v: 1,
				jobs: [
					{
						id: "j1",
						class: "bulk",
						kind: "vm-check",
						state: "waiting",
						owner: { session: "session-w", pid: 1 },
						what: "nix build .#checks.vm-a",
						memoryGib: 6,
						since: new Date().toISOString(),
						place: 1,
					},
				],
			})}\n`,
		);
		peer("session-w", ["WCJQSG"], []);
		leased("session-w", { kind: "heavy", subject: "vm-check" });
		const { tools } = await startSession({ XDG_RUNTIME_DIR: runtime });

		const listed = await tools.get("mesh_groups")?.execute("call-g", {});

		expect(listed?.content[0]?.text).toMatch(
			/\nLeases:\nWCJQSG: waiting at place 1 to run a VM check, since \d\d:\d\d \(nix build \.#checks\.vm-a\)$/,
		);
	});
});
