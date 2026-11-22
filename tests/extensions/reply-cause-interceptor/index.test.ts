/**
 * A finished reply stating an untested cause is followed by one note to
 * the model, never held; anything else, or a reply the person has moved
 * past, is left alone.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	replyCauseInterceptor,
	UNTESTED_REPLY_MESSAGE,
} from "../../../extensions/reply-cause-interceptor/index.ts";
import type { Classify, FoundClassifier } from "../../../lib/classifier/jev.ts";
import {
	restoreSessionModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import { type FakePi, fakePi } from "../../support/fake-pi.ts";

const CAUSE = "The build failed because the cache was corrupted by the reboot.";
const STATUS = "The build is green and the branch is pushed.";

let pi: FakePi;
let sentWith: unknown[];
let judgments: Promise<void>[];
let judged: string[];
let found: FoundClassifier;

/** A classifier sure of an untested cause in any part naming a cache. */
const classify: Classify = async (context) => {
	const part = String(Reflect.get(context.state, "message"));
	judged.push(part);
	const sure = part.includes("cache") ? 0.97 : 0.05;
	return {
		stopReason: "stop",
		answers: {
			cause: { probabilities: { untested_cause: sure } },
		},
	} as unknown as Awaited<ReturnType<Classify>>;
};

beforeEach(() => {
	pi = fakePi();
	sentWith = [];
	judgments = [];
	judged = [];
	found = { ok: true, classify, label: "typesafe/jev-latest" };
	const send = pi.sendMessage;
	pi.sendMessage = (message, options) => {
		sentWith.push(options);
		send(message, options);
	};
	replyCauseInterceptor({
		classifier: async () => found,
		judging: (judgment) => judgments.push(judgment),
	})(pi);
});

afterEach(() => restoreSessionModes({}));

const handler = (event: string) => {
	const [one] = pi.recorded.handlers.get(event) ?? [];
	if (!one) throw new Error(`nothing listens for ${event}`);
	return one;
};

const replyStopping = (stopReason: string, ...content: object[]) =>
	handler("message_end")(
		{
			type: "message_end",
			message: { role: "assistant", content, stopReason },
		},
		{},
	);

const reply = (...content: object[]) => replyStopping("stop", ...content);

const typed = () =>
	handler("input")({ type: "input", text: "ok", source: "interactive" }, {});

const text = (said: string) => ({ type: "text", text: said });

const allJudged = () => Promise.all(judgments);

const notes = () =>
	pi.recorded.sent.filter(
		(message) => message.customType === UNTESTED_REPLY_MESSAGE,
	);

describe("a finished reply", () => {
	it("stating an untested cause is followed by one note quoting it", async () => {
		const answer = await reply(text(`${STATUS}\n\n${CAUSE}`));
		await allJudged();

		expect(answer).toBeUndefined();
		expect(notes()).toHaveLength(1);
		expect(String(notes()[0]?.content)).toContain(`> ${CAUSE}`);
		expect(sentWith).toEqual([{ deliverAs: "followUp", triggerTurn: true }]);
	});

	it("stating no cause is followed by nothing", async () => {
		await reply(text(STATUS));
		await allJudged();

		expect(judged).toEqual([STATUS]);
		expect(notes()).toEqual([]);
	});

	it("answering the note goes unjudged, so a note can't follow a note", async () => {
		await reply(text(CAUSE));
		await allJudged();
		await reply(text(`On reflection: ${CAUSE}`));
		await allJudged();

		expect(judged).toEqual([CAUSE]);
		expect(notes()).toHaveLength(1);
	});

	it("is judged again once the person has spoken after a note", async () => {
		await reply(text(CAUSE));
		await allJudged();
		await typed();
		await reply(text(CAUSE));
		await allJudged();

		expect(notes()).toHaveLength(2);
	});

	it("sends nothing when the person spoke while it was judged", async () => {
		await reply(text(CAUSE));
		await typed();
		await allJudged();

		expect(notes()).toEqual([]);
	});

	it("is judged by its text alone, not its thinking", async () => {
		await reply({ type: "thinking", thinking: CAUSE }, text(STATUS));
		await allJudged();

		expect(judged).toEqual([STATUS]);
	});
});

describe("a reply left unjudged", () => {
	it("is one still calling tools", async () => {
		await reply(text(CAUSE), {
			type: "toolCall",
			id: "c1",
			name: "bash",
			arguments: {},
		});
		await allJudged();

		expect(judged).toEqual([]);
	});

	it("is one stopped by the person or an error", async () => {
		await replyStopping("aborted", text(CAUSE));
		await replyStopping("error", text(CAUSE));
		await allJudged();

		expect(judged).toEqual([]);
	});

	it("is every one while the guard is off, so no text leaves", async () => {
		setSessionMode("untested-cause", "off");
		await reply(text(CAUSE));
		await allJudged();

		expect(judgments).toEqual([]);
		expect(judged).toEqual([]);
	});

	it("is every one with no classifier, which sends nothing", async () => {
		found = { ok: false, reason: "no Jev classifier has credentials" };
		await reply(text(CAUSE));
		await allJudged();

		expect(notes()).toEqual([]);
	});

	it("is one from the person or a tool", async () => {
		await handler("message_end")(
			{ type: "message_end", message: { role: "user", content: CAUSE } },
			{},
		);
		await allJudged();

		expect(judgments).toEqual([]);
	});
});
