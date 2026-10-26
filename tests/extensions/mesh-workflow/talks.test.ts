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
	createTalks,
	ended,
	READING_MS,
} from "../../../extensions/mesh-workflow/talks.ts";
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

function stages(id: string): Array<Record<string, unknown>> {
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
		following.opened(
			{ text: "how is it going?", from: "joel", at: "t0", id: "t1", file: "f" },
			inbox,
		);
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

	it("fails when the run is stopped or writes nothing", () => {
		const following = talks();
		following.opened({ text: "a", id: "t1", file: "f" }, inbox);
		following.settled(true);
		following.opened({ text: "b", id: "t2", file: "f" }, inbox);
		following.settled(false);

		expect(stages("t1").at(-1)).toEqual({ stage: "failed", why: "stopped" });
		expect(stages("t2").at(-1)).toEqual({
			stage: "failed",
			why: "the run wrote no reply",
		});
	});

	it("hears what came of it until the next talk opens", () => {
		const following = talks();
		following.opened({ text: "a", id: "t1", file: "f" }, inbox);
		following.wrote("On it.");
		following.settled(false);
		following.came(
			ended("PLAN-20261026-ABCDEF", "concluded"),
			"PLAN-20261026-ABCDEF",
		);
		following.opened({ text: "b", id: "t2", file: "f" }, inbox);
		following.came("quest retired");

		expect(stages("t1").at(-1)).toEqual({
			stage: "came",
			what: "plan concluded",
			ref: "PLAN-20261026-ABCDEF",
		});
		expect(stages("t2").at(-1)).toEqual({
			stage: "came",
			what: "quest retired",
		});
		expect(stages("t1")).toHaveLength(3);
	});

	it("is not opened by a steer without an id", () => {
		const following = talks();
		following.opened({ text: "a", file: "f" }, inbox);
		following.settled(false);
		expect(existsSync(join(inbox, "replies"))).toBe(false);
	});
});

describe("an assistant message's text", () => {
	it("joins its text parts and ignores everything else", () => {
		expect(
			assistantText({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hm" },
					{ type: "text", text: "Hello " },
					{ type: "toolCall", name: "bash" },
					{ type: "text", text: "there" },
				],
			}),
		).toBe("Hello there");
		expect(assistantText({ role: "user", content: "hi" })).toBe("");
		expect(assistantText(null)).toBe("");
	});
});
