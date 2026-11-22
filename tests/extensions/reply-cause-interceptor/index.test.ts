/**
 * The last reply of a run the person began, stating an untested cause,
 * is followed by one note to the model once pi settles, never held;
 * anything else, or a reply the person has moved past, is left alone.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	NOTE_REASON,
	replyCauseInterceptor,
	replyClassifier,
} from "../../../extensions/reply-cause-interceptor/index.ts";
import type { Classify, FoundClassifier } from "../../../lib/classifier/jev.ts";
import {
	restoreSessionModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import {
	automatedText,
	isAutomatedText,
} from "../../../lib/internal/automated.ts";
import { type FakePi, fakePi } from "../../support/fake-pi.ts";

const CAUSE = "The build failed because the cache was corrupted by the reboot.";
const STATUS = "The build is green and the branch is pushed.";

let pi: FakePi;
let judgments: Promise<void>[];
let judged: string[];
let lookups: number;
let lookup: () => Promise<FoundClassifier>;
let gate: Promise<void>;
let idle: boolean;
let hasUI: boolean;

/** A classifier sure of an untested cause in any part naming a cache. */
const classify: Classify = async (context) => {
	const part = String(Reflect.get(context.state, "message"));
	judged.push(part);
	await gate;
	const sure = part.includes("cache") ? 0.97 : 0.05;
	return {
		stopReason: "stop",
		answers: {
			cause: { probabilities: { untested_cause: sure } },
		},
	} as unknown as Awaited<ReturnType<Classify>>;
};

const FOUND: FoundClassifier = {
	ok: true,
	classify,
	label: "typesafe/jev-latest",
};

/** Holds every classifier answer until the test lets it go. */
function holdAnswers(): () => void {
	let release = () => {};
	gate = new Promise((done) => {
		release = done;
	});
	return release;
}

const install = (classifier: (ctx: object) => Promise<FoundClassifier>) =>
	replyCauseInterceptor({
		classifier,
		judging: (judgment) => judgments.push(judgment),
	})(pi);

beforeEach(() => {
	pi = fakePi();
	judgments = [];
	judged = [];
	lookups = 0;
	gate = Promise.resolve();
	idle = true;
	hasUI = true;
	lookup = async () => FOUND;
	install(() => {
		lookups += 1;
		return lookup();
	});
});

afterEach(() => restoreSessionModes({}));

const handler = (event: string) => {
	const [one] = pi.recorded.handlers.get(event) ?? [];
	if (!one) throw new Error(`nothing listens for ${event}`);
	return one;
};

const ctx = () => ({ hasUI, isIdle: () => idle, modelRegistry: {} });

const input = (text: string) =>
	handler("input")({ type: "input", text, source: "interactive" }, ctx());

const personSays = () => input("Why did the build fail?");

const automatedSays = () =>
	input(automatedText("background work is reporting", "j1 ended."));

const assistant = (stopReason: string, ...content: object[]) => ({
	role: "assistant",
	content,
	stopReason,
});

const runEnds = (...messages: object[]) => {
	handler("agent_start")({ type: "agent_start" }, ctx());
	return handler("agent_end")({ type: "agent_end", messages }, ctx());
};

const settles = (aborted = false) =>
	handler("agent_settled")({ type: "agent_settled", aborted }, ctx());

const text = (said: string) => ({ type: "text", text: said });

const toolCall = { type: "toolCall", id: "c1", name: "bash", arguments: {} };

/** The person speaks, the model replies once, and pi settles. */
async function turn(...content: object[]): Promise<void> {
	await personSays();
	await runEnds(assistant("stop", ...content));
	await settles();
}

/** The run a note starts: its automated turn, a reply, then a settle. */
async function noteAnswered(...messages: object[]): Promise<void> {
	const [note] = notes();
	await input(String(note));
	await runEnds(...messages);
	await settles();
}

const allJudged = () => Promise.all(judgments);

const notes = () =>
	pi.recorded.sentAsUser.filter(
		(message) => typeof message === "string" && message.includes(NOTE_REASON),
	);

describe("a reply to the person", () => {
	it("stating an untested cause is followed by one automated note quoting it", async () => {
		await turn(text(`${STATUS}\n\n${CAUSE}`));
		await allJudged();

		expect(notes()).toHaveLength(1);
		expect(String(notes()[0])).toContain(`> ${CAUSE}`);
		expect(isAutomatedText(String(notes()[0]))).toBe(true);
	});

	it("stating no cause is followed by nothing", async () => {
		await turn(text(STATUS));
		await allJudged();

		expect(judged).toEqual([STATUS]);
		expect(notes()).toEqual([]);
	});

	it("is never held: the settle returns while the judgment is still out", async () => {
		const release = holdAnswers();
		await personSays();
		await runEnds(assistant("stop", text(CAUSE)));

		const answer = settles();

		expect(answer).toBeUndefined();
		expect(judgments).toHaveLength(1);
		let done = false;
		void judgments[0]?.then(() => {
			done = true;
		});
		await new Promise((settled) => setImmediate(settled));
		expect(done, "judging waits on the classifier").toBe(false);
		release();
		await allJudged();
		expect(notes()).toHaveLength(1);
	});

	it("is judged by its last reply, after the tools it called", async () => {
		await personSays();
		await runEnds(
			assistant("toolUse", text(CAUSE), toolCall),
			{ role: "toolResult", content: [text("ok")] },
			assistant("stop", text(STATUS)),
		);
		await settles();
		await allJudged();

		expect(judged).toEqual([STATUS]);
	});

	it("answering the note goes unjudged, even when it calls tools first", async () => {
		await turn(text(CAUSE));
		await allJudged();
		await noteAnswered(
			assistant("toolUse", text("Checking."), toolCall),
			assistant("stop", text(`On reflection: ${CAUSE}`)),
		);
		await allJudged();

		expect(judged).toEqual([CAUSE]);
		expect(notes()).toHaveLength(1);
	});

	it("answering a note that ended in an error leaves the next reply judged", async () => {
		await turn(text(CAUSE));
		await allJudged();
		await noteAnswered(assistant("error", text("The provider failed.")));
		await turn(text(CAUSE));
		await allJudged();

		expect(notes()).toHaveLength(2);
	});

	it("is judged again once the person has spoken after a note", async () => {
		await turn(text(CAUSE));
		await allJudged();
		await noteAnswered(assistant("stop", text(STATUS)));
		await turn(text(CAUSE));
		await allJudged();

		expect(notes()).toHaveLength(2);
	});

	it("sends nothing when the person spoke while it was judged", async () => {
		const release = holdAnswers();
		await turn(text(CAUSE));
		await personSays();
		release();
		await allJudged();

		expect(notes()).toEqual([]);
	});

	it("sends nothing when another run started while it was judged", async () => {
		const release = holdAnswers();
		await turn(text(CAUSE));
		await automatedSays();
		release();
		await allJudged();

		expect(notes()).toEqual([]);
	});

	it("sends nothing when pi is busy by the time it is judged", async () => {
		const release = holdAnswers();
		await turn(text(CAUSE));
		idle = false;
		release();
		await allJudged();

		expect(notes()).toEqual([]);
	});

	it("is judged by its text alone, not its thinking or code blocks", async () => {
		await turn(
			{ type: "thinking", thinking: CAUSE },
			text(
				[
					"```",
					"failed because the cache was corrupted",
					"```",
					"",
					STATUS,
				].join("\n"),
			),
		);
		await allJudged();

		expect(judged).toEqual([STATUS]);
	});
});

describe("a reply left unjudged", () => {
	it("is one still calling tools", async () => {
		await turn(text(CAUSE), toolCall);
		await allJudged();

		expect(judgments).toEqual([]);
	});

	it("is one stopped by the person, an error or the length limit", async () => {
		for (const stopReason of ["aborted", "error", "length"]) {
			await personSays();
			await runEnds(assistant(stopReason, text(CAUSE)));
			await settles();
		}
		await allJudged();

		expect(judgments).toEqual([]);
	});

	it("is one in a run pi settled as aborted", async () => {
		await personSays();
		await runEnds(assistant("stop", text(CAUSE)));
		await settles(true);

		expect(judgments).toEqual([]);
	});

	it("is one in a run an automated turn began, since nobody asked", async () => {
		await automatedSays();
		await runEnds(assistant("stop", text(CAUSE)));
		await settles();

		expect(judgments).toEqual([]);
	});

	it("is one in print or JSON mode, with no person reading", async () => {
		hasUI = false;
		await turn(text(CAUSE));

		expect(judgments).toEqual([]);
	});

	it("is every one while the guard is off, so no text leaves", async () => {
		setSessionMode("untested-cause", "off");
		await turn(text(CAUSE));

		expect(judgments).toEqual([]);
		expect(lookups).toBe(0);
	});

	it("is every one with no classifier, which is looked for again at the next", async () => {
		lookup = async () => ({
			ok: false,
			reason: "no Jev classifier has credentials",
		});
		await turn(text(CAUSE));
		await allJudged();
		lookup = async () => FOUND;
		await turn(text(CAUSE));
		await allJudged();

		expect(lookups).toBe(2);
		expect(judged).toEqual([CAUSE]);
		expect(notes()).toHaveLength(1);
	});

	it("is every one while finding a classifier fails, which says nothing", async () => {
		lookup = async () => {
			throw new Error("the registry is not ready");
		};
		await turn(text(CAUSE));
		await expect(allJudged()).resolves.toBeDefined();
		await turn(text(CAUSE));

		await expect(allJudged()).resolves.toBeDefined();
		expect(lookups).toBe(2);
		expect(notes()).toEqual([]);
	});

	it("still ends quietly when the note can't be sent", async () => {
		pi.sendUserMessage = () => {
			throw new Error("This extension ctx is stale");
		};
		await turn(text(CAUSE));

		await expect(allJudged()).resolves.toBeDefined();
	});
});

describe("the classifier for replies", () => {
	const registry = (asked: string[]) => ({
		modelRegistry: {
			getAvailableOfType: async () => [
				{ provider: "typesafe", id: "jev-latest" },
				{ provider: "opencode", id: "jev-1.13" },
			],
			classify: async (model: { provider: string }) => {
				asked.push(model.provider);
				return { stopReason: "stop", answers: {} };
			},
		},
	});

	it("is none when the mesh's classifier is off, so no reply's text leaves", async () => {
		const asked: string[] = [];
		const found = await replyClassifier({ PI_MESH_CLASSIFIER: "off" })(
			registry(asked) as never,
		);

		expect(found).toMatchObject({ ok: false, off: true });
	});

	it("is the one the mesh's setting names", async () => {
		const asked: string[] = [];
		const found = await replyClassifier({
			PI_MESH_CLASSIFIER: "opencode/jev-1.13",
		})(registry(asked) as never);
		if (!found.ok) throw new Error(found.reason);
		await found.classify({ state: {}, questions: {} });

		expect(asked).toEqual(["opencode"]);
	});
});
