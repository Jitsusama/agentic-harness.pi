/**
 * Talks followed by a session: from the steer it took to its reply,
 * and what came of it after.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assistantText,
	CAME_MS,
	createTalks,
	ended,
	endsForGood,
	READING_MS,
	type Talks,
	userText,
} from "../../../extensions/mesh-workflow/talks.ts";
import type { Steer } from "../../../lib/mesh/steer.ts";
import { talkFile } from "../../../lib/mesh/talk.ts";

let inbox: string;
let clock: number;

beforeEach(() => {
	inbox = join(mkdtempSync(join(tmpdir(), "talks-")), "WCJQSG");
	clock = Date.parse("2026-10-26T06:00:00Z");
});

afterEach(() => {
	rmSync(join(inbox, ".."), { recursive: true, force: true });
});

const talks = () => createTalks({ session: () => "s1", now: () => clock });

/** The message a steer is delivered as, standing in for steerText. */
const said = (steer: Steer) => `[Steered]\n\n${steer.text}`;

/** A steer delivered, and its message reaching the conversation. */
function take(following: Talks, steer: Steer): void {
	following.opened(steer, inbox, said(steer));
	following.heard(said(steer));
}

function stages(id: string): Record<string, unknown>[] {
	return readFileSync(talkFile(inbox, id), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.map(({ at: _at, ...rest }) => rest);
}

describe("a talk a session follows", () => {
	it("goes from delivered through reading and replying to replied", () => {
		const following = talks();
		following.wrote("said before the steer came");
		take(following, {
			text: "how is it going?",
			from: "joel",
			at: "t0",
			id: "t1",
			file: "f",
		});
		clock += 5_000;
		following.step("bash");
		clock += READING_MS - 1;
		following.step("read");
		clock += 1;
		following.step("edit");
		following.writing("Going");
		following.writing("Going well");
		following.wrote("Going well.");
		following.settled(false);
		following.writing("after the talk closed");

		expect(stages("t1")).toEqual([
			{
				stage: "delivered",
				session: "s1",
				text: "how is it going?",
				from: "joel",
				sentAt: "t0",
			},
			{ stage: "reading", after: "bash, 5 s" },
			{ stage: "reading", after: "edit, 35 s" },
			{ stage: "replying", text: "Going" },
			{ stage: "replied", text: "Going well." },
		]);
	});

	it("waits for the run that takes its steer, not the one ending as it came", () => {
		// A busy session's steer is read after the current tool; a run in
		// its last turn can end first, and pi starts a new run for it.
		const following = talks();
		const steer = { text: "status?", id: "t1", file: "f" };
		following.opened(steer, inbox, said(steer));
		following.step("bash");
		following.writing("Done with the build");
		following.wrote("Done with the build.");
		following.settled(false);
		expect(stages("t1").map(({ stage }) => stage)).toEqual(["delivered"]);

		following.heard(`Some words first.\n\n${said(steer)}`);
		following.wrote("All green.");
		following.settled(false);
		expect(stages("t1")).toEqual([
			{ stage: "delivered", session: "s1", text: "status?" },
			{ stage: "replied", text: "All green." },
		]);
	});

	it("into a busy run, is replied by the first text written after it, before the run ends", () => {
		const following = talks();
		following.step("bash");
		take(following, { text: "hello", from: "joel", id: "t1", file: "f" });
		following.writing("Hi Joel, the");
		following.wrote("Hi Joel, the build is next.");
		expect(stages("t1").at(-1)).toEqual({
			stage: "replied",
			text: "Hi Joel, the build is next.",
		});

		following.step("bash");
		following.writing("Build");
		following.wrote("Build passed.");
		following.settled(false);
		expect(stages("t1").map(({ stage }) => stage)).toEqual([
			"delivered",
			"replying",
			"replied",
		]);
	});

	it("into an idle session, is replied by its first text at once, then by its run's last", () => {
		const following = talks();
		take(following, { text: "status?", id: "t1", file: "f" });
		following.wrote("Let me look.");
		expect(stages("t1").at(-1)).toEqual({
			stage: "replied",
			text: "Let me look.",
		});

		following.step("bash");
		following.wrote("All green.");
		following.settled(false);
		expect(stages("t1").map(({ stage }) => stage)).toEqual([
			"delivered",
			"replied",
			"reading",
			"replied",
		]);
		expect(stages("t1").at(-1)).toEqual({
			stage: "replied",
			text: "All green.",
		});
	});

	it("into an idle session, says its reply once when the run ends on the same words", () => {
		const following = talks();
		take(following, { text: "route this", id: "t1", file: "f" });
		following.wrote("→ The Agentic Loop · undo");
		following.wrote("→ The Agentic Loop · undo");
		following.settled(false);

		expect(stages("t1")).toEqual([
			{ stage: "delivered", session: "s1", text: "route this" },
			{ stage: "replied", text: "→ The Agentic Loop · undo" },
		]);
	});

	it("says a reply so far only when it has changed", () => {
		const following = talks();
		take(following, { text: "a", id: "t1", file: "f" });
		for (let second = 0; second < 3; second++) {
			following.writing("Now the tests:");
			clock += 1_000;
		}
		following.writing("Now the tests: all");
		expect(stages("t1").filter(({ stage }) => stage === "replying")).toEqual([
			{ stage: "replying", text: "Now the tests:" },
			{ stage: "replying", text: "Now the tests: all" },
		]);
	});

	it("fails when the run is stopped or writes nothing", () => {
		const following = talks();
		take(following, { text: "a", id: "t1", file: "f" });
		following.settled(true);
		take(following, { text: "b", id: "t2", file: "f" });
		following.settled(false);

		expect(stages("t1").at(-1)).toEqual({ stage: "failed", why: "stopped" });
		expect(stages("t2").at(-1)).toEqual({
			stage: "failed",
			why: "the run wrote no reply",
		});
	});

	it("hears what came of it within the hour, until the next talk opens", () => {
		const following = talks();
		take(following, { text: "a", id: "t1", file: "f" });
		following.wrote("On it.");
		following.settled(false);
		following.came(
			ended("PLAN-20261026-ABCDEF", "concluded"),
			"PLAN-20261026-ABCDEF",
		);
		clock += CAME_MS;
		following.came("quest concluded", "QEST-20261026-LATERQ");
		take(following, { text: "b", id: "t2", file: "f" });
		following.came("quest retired");

		expect(stages("t1").at(-1)).toEqual({
			stage: "came",
			what: "plan concluded",
			ref: "PLAN-20261026-ABCDEF",
		});
		expect(stages("t1")).toHaveLength(3);
		expect(stages("t2").at(-1)).toEqual({
			stage: "came",
			what: "quest retired",
		});
	});

	it("keeps the talk a steer answers in place, as delivered says it", () => {
		const following = talks();
		take(following, { text: "and the tests?", id: "t2", re: "t1", file: "f" });

		expect(stages("t2")[0]).toEqual({
			stage: "delivered",
			session: "s1",
			text: "and the tests?",
			re: "t1",
		});
	});

	it("is over once a newer talk to the session is replied, not while its work carries on", () => {
		const following = talks();
		take(following, { text: "a", id: "t1", file: "f" });
		following.wrote("On it.");
		following.settled(false);
		following.step("bash");
		following.wrote("Carrying on with the build.");
		following.settled(false);
		expect(stages("t1").at(-1)).toEqual({ stage: "replied", text: "On it." });

		take(following, { text: "b", id: "t2", file: "f" });
		following.wrote("Done.");
		following.settled(false);

		expect(stages("t1").at(-1)).toEqual({
			stage: "over",
			why: "a newer talk was answered",
		});
		expect(stages("t2").at(-1)).toEqual({ stage: "replied", text: "Done." });
	});

	it("keeps its own reply when a newer talk comes into the run it started", () => {
		// The void's 18:57 run was still going when Joel's 18:59 line came
		// (8GYNJ6, 13 Nov): the newer line's answer was filed under both.
		const following = talks();
		take(following, { text: "first", id: "t1", file: "f" });
		following.wrote("Loop has it · undo 18:57");
		following.step("bash");
		take(following, { text: "second", id: "t2", file: "f" });
		following.writing("Launcher has");
		following.wrote("Launcher has it · undo 18:59");
		following.step("bash");
		following.settled(false);

		const replies = (id: string) =>
			stages(id)
				.filter(({ stage }) => stage === "replying" || stage === "replied")
				.map(({ text }) => text);
		expect(replies("t1")).toEqual(["Loop has it · undo 18:57"]);
		expect(stages("t1").at(-1)).toEqual({
			stage: "over",
			why: "a newer talk was answered",
		});
		expect(replies("t2")).toEqual([
			"Launcher has",
			"Launcher has it · undo 18:59",
		]);
		expect(stages("t2").at(-1)).toEqual({
			stage: "replied",
			text: "Launcher has it · undo 18:59",
		});
	});

	it("ends a talk answered before a reload, once, when a newer one is replied after it", () => {
		const before = talks();
		take(before, { text: "a", id: "t1", file: "f" });
		before.wrote("On it.");
		before.settled(false);

		const after = talks();
		for (const id of ["t2", "t3"]) {
			take(after, { text: id, id, file: "f" });
			after.wrote(`Answered ${id}.`);
			after.settled(false);
		}

		expect(stages("t1").filter(({ stage }) => stage === "over")).toHaveLength(
			1,
		);
		expect(stages("t2").at(-1)).toEqual({
			stage: "over",
			why: "a newer talk was answered",
		});
		expect(stages("t3").at(-1)).toEqual({
			stage: "replied",
			text: "Answered t3.",
		});
	});

	it("is over once a newer talk is replied after a rollover gave the session a new id", () => {
		const before = createTalks({ session: () => "s0", now: () => clock });
		take(before, { text: "a", id: "t1", file: "f" });
		before.wrote("On it.");
		before.settled(false);

		const after = talks();
		take(after, { text: "b", id: "t2", file: "f" });
		after.wrote("Done.");
		after.settled(false);

		expect(stages("t1").at(-1)).toEqual({
			stage: "over",
			why: "a newer talk was answered",
		});
	});

	it("is over when the session ends, in every inbox it answers from", () => {
		const following = createTalks({
			session: () => "s1",
			now: () => clock,
			inboxes: () => [inbox],
		});
		take(following, { text: "a", id: "t1", file: "f" });
		following.wrote("On it.");
		following.settled(false);
		take(following, { text: "b", id: "t2", file: "f" });

		following.ended();

		expect(stages("t1").map(({ stage }) => stage)).toEqual([
			"delivered",
			"replied",
			"over",
		]);
		expect(stages("t1").at(-1)).toEqual({
			stage: "over",
			why: "the session ended",
		});
		expect(stages("t2").map(({ stage }) => stage)).toEqual(["delivered"]);
	});

	it("is not opened by a steer without an id", () => {
		const following = talks();
		take(following, { text: "a", file: "f" });
		following.settled(false);
		const replies = join(inbox, "replies");
		expect(existsSync(replies), `${replies} is not made`).toBe(false);
	});
});

describe("a session's shutdown", () => {
	const calm = { parked: false, restarting: false };

	it("ends it for good only when pi quits with nothing to bring it back", () => {
		const quit = { reason: "quit" };
		expect(endsForGood(quit, calm), "a plain quit").toBe(true);
		const parked = { ...calm, parked: true };
		expect(endsForGood(quit, parked), "a park").toBe(false);
		const restarting = { ...calm, restarting: true };
		expect(endsForGood(quit, restarting), "a restart").toBe(false);
		for (const reason of ["reload", "new", "resume", "fork"]) {
			expect(endsForGood({ reason }, calm), reason).toBe(false);
		}
		expect(endsForGood(undefined, calm), "no event").toBe(false);
	});
});

describe("a message's text", () => {
	it("joins its text parts for its own role and ignores everything else", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hm" },
				{ type: "text", text: "Hello " },
				{ type: "toolCall", name: "bash" },
				{ type: "text", text: "there" },
			],
		};
		expect(assistantText(message)).toBe("Hello there");
		expect(userText(message)).toBe("");
		expect(userText({ role: "user", content: "hi" })).toBe("hi");
		expect(assistantText(null)).toBe("");
	});
});
