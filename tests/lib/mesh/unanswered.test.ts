/**
 * Every question on the mesh still waiting on a peer it named, so a
 * stuck session shows up before the person notices it.
 */
import { describe, expect, it } from "vitest";
import type { Message } from "../../../lib/mesh/message.ts";
import {
	UNANSWERED_WITHIN_MS,
	unanswered,
	withinOrchestration,
} from "../../../lib/mesh/unanswered.ts";

const now = Date.parse("2026-10-26T01:30:00.000Z");
let made = 0;

function message(over: Partial<Message>): Message {
	made += 1;
	return {
		v: 1,
		id: `${made}-WCJQSG-1-${String(made).padStart(8, "0")}`,
		at: new Date(now - 60_000).toISOString(),
		from: "WCJQSG",
		to: ["@5FWIUS"],
		text: "what does the disk guard say?",
		intent: "question",
		pid: 1,
		...over,
	};
}

const aliases = (address: string) =>
	["WCJQSG", "P9R1KI"].includes(address) ? ["WCJQSG", "P9R1KI"] : [address];

describe("questions still unanswered", () => {
	it("waits on each address that has not answered, oldest question first", () => {
		const late = message({ at: new Date(now - 60_000).toISOString() });
		const early = message({
			at: new Date(now - 600_000).toISOString(),
			to: ["@85PKB2", "@Y2YBTS"],
		});
		const answer = message({
			from: "Y2YBTS",
			to: ["@WCJQSG"],
			intent: "fyi",
			re: early.id,
		});

		expect(unanswered([late, early, answer], aliases, now)).toEqual([
			{ message: early, waitingOn: ["85PKB2"] },
			{ message: late, waitingOn: ["5FWIUS"] },
		]);
	});

	it("counts an answer from any address the peer goes by", () => {
		const asked = message({ from: "5FWIUS", to: ["@P9R1KI"] });
		const answer = message({ from: "WCJQSG", intent: "fyi", re: asked.id });
		expect(unanswered([asked, answer], aliases, now)).toEqual([]);
	});

	it("counts an answer anywhere in the question's thread", () => {
		const asked = message({ to: ["@5FWIUS", "@Y2YBTS"] });
		const reply = message({ from: "Y2YBTS", intent: "fyi", re: asked.id });
		const more = message({ to: ["@Y2YBTS"], re: reply.id, intent: "fyi" });
		const late = message({ from: "5FWIUS", intent: "fyi", re: more.id });
		expect(unanswered([asked, reply, more, late], aliases, now)).toEqual([]);
	});

	it("closes a question its asker moved on from by asking again", () => {
		const asked = message({ to: ["@85PKB2"] });
		const instead = message({ to: ["@85PKB2"], re: asked.id });
		expect(
			unanswered([asked, instead], aliases, now).map((one) => one.message),
		).toEqual([instead]);
	});

	it("leaves out what needs no answer here", () => {
		const toGroup = message({ to: ["#quest/wcjqsg"] });
		const told = message({ intent: "fyi" });
		const old = message({
			at: new Date(now - UNANSWERED_WITHIN_MS - 1).toISOString(),
		});
		const withdrawn = message({});
		const instead = message({ supersedes: withdrawn.id });
		const toItself = message({ to: ["@WCJQSG"] });

		expect(unanswered([toGroup, told, old, toItself], aliases, now)).toEqual(
			[],
		);
		expect(
			unanswered([withdrawn, instead], aliases, now).map((one) => one.message),
		).toEqual([instead]);
	});
});

describe("an orchestration's own unanswered questions", () => {
	it("keeps those asked in it or waiting on it, and leaves the rest of the mesh out", () => {
		const fromInside = message({ from: "QCXZEB", to: ["@N10TYF"] });
		const toInside = message({ from: "N10TYF", to: ["@85PKB2"] });
		const elsewhere = message({ from: "N10TYF", to: ["@19AMVE"] });
		const open = unanswered([fromInside, toInside, elsewhere], aliases, now);

		const mine = withinOrchestration(open, new Set(["QCXZEB", "85PKB2"]));

		expect(mine.map((one) => one.message)).toEqual([fromInside, toInside]);
	});
});
