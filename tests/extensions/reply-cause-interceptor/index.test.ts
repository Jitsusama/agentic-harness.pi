/**
 * The last reply of a run the person began, stating an untested cause,
 * is followed by one note to the model once pi settles, never held;
 * anything else, or a reply the person has moved past, is left alone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	NOTE_REASON,
	NOTED,
	replyCauseInterceptor,
	replyClassifier,
	UNJUDGED,
} from "../../../extensions/reply-cause-interceptor/index.ts";
import type { Classify, FoundClassifier } from "../../../lib/classifier/jev.ts";
import { installHost, withSession } from "../../../lib/core/session/index.ts";
import {
	restoreSessionModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import {
	automatedText,
	isAutomatedText,
} from "../../../lib/internal/automated.ts";
import { goAway, resetAway } from "../../../lib/internal/away/state.ts";
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
let pending: boolean;
let typed: string;
let sessionId: string;
let unhost: (() => void) | undefined;

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
	pending = false;
	typed = "";
	sessionId = "session-1";
	lookup = async () => FOUND;
	install(() => {
		lookups += 1;
		return lookup();
	});
});

afterEach(() => {
	// First, so a host a test installed never outlives it.
	unhost?.();
	unhost = undefined;
	restoreSessionModes({});
	resetAway();
});

const handler = (event: string) => {
	const [one] = pi.recorded.handlers.get(event) ?? [];
	if (!one) throw new Error(`nothing listens for ${event}`);
	return one;
};

const ctx = () => ({
	hasUI,
	isIdle: () => idle,
	hasPendingMessages: () => pending,
	ui: { getEditorText: () => typed },
	modelRegistry: {},
	sessionManager: { getSessionId: () => sessionId },
});

const input = (text: string, streamingBehavior?: "steer" | "followUp") =>
	handler("input")(
		{ type: "input", text, source: "interactive", streamingBehavior },
		ctx(),
	);

/** A stretch is about to begin, by what pi says began it. */
const begins = (messageType: string) =>
	handler("before_agent_start")(
		{ type: "before_agent_start", messageType },
		ctx(),
	);

/** A custom message, a peer's or a job's, wakes pi and begins a run. */
const customBegins = () => begins("custom");

/** A peer's steer, framed as the mesh frames one from outside the window. */
const peerSteers = () =>
	input("[9R6RA6 is asking from outside this window] Why did the build fail?");

/** The person's own steer from the launcher, framed the same way. */
const personSteers = () =>
	input(
		"[the person is asking from outside this window] Why did the build fail?",
	);

/** The person's words from idle, as pi hears them before the run they begin. */
const personSays = async () => {
	await input("Why did the build fail?");
	await begins("user");
};

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
		expect(pi.recorded.entries).toEqual([
			{ customType: NOTED, data: { parts: 1 } },
		]);
	});

	it("is judged when the person steers from the launcher", async () => {
		await personSteers();
		await runEnds(assistant("stop", text(CAUSE)));
		await settles();
		await allJudged();

		expect(judged).toEqual([CAUSE]);
	});

	it("is judged in a hosted conversation a window views, which has no screen of its own", async () => {
		hasUI = false;
		sessionId = "hosted-1";
		unhost = installHost({
			viewed: (id: string) => id === "hosted-1",
		} as never);
		// The host runs each conversation's hooks as that conversation.
		await withSession("hosted-1", async () => {
			await turn(text(CAUSE));
			await allJudged();
		});

		expect(notes()).toHaveLength(1);
	});

	it("is judged by the stretch's last reply, a retry inside it among its runs", async () => {
		await personSays();
		await runEnds(assistant("error", text("The provider failed.")));
		// pi retries inside the stretch the person's words began.
		await runEnds(assistant("stop", text(CAUSE)));
		await settles();
		await allJudged();

		expect(judged).toEqual([CAUSE]);
	});

	it("is judged when a host queues the person's words as a follow-up while idle", async () => {
		await input("Why did the build fail?", "followUp");
		await begins("user");
		await runEnds(assistant("stop", text(CAUSE)));
		await settles();
		await allJudged();

		expect(judged).toEqual([CAUSE]);
	});

	it("is judged with its secrets scrubbed, so none reaches the provider", async () => {
		const token = `github_pat_${"A1".repeat(20)}`;
		await turn(text(`${STATUS} The token is ${token}.`));
		await allJudged();

		expect(judged.join("\n")).not.toContain(token);
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

	it("sends nothing when an automated turn came while it was judged", async () => {
		const release = holdAnswers();
		await turn(text(CAUSE));
		await automatedSays();
		release();
		await allJudged();

		expect(notes()).toEqual([]);
	});

	it("sends nothing when a run no input began came and went while it was judged", async () => {
		const release = holdAnswers();
		await turn(text(CAUSE));
		await customBegins();
		await runEnds(assistant("stop", text(STATUS)));
		release();
		await allJudged();

		expect(notes()).toEqual([]);
	});

	it.each([
		[
			"a message waits",
			() => {
				pending = true;
			},
		],
		[
			"the person has typed their next ask",
			() => {
				typed = "And the tests?";
			},
		],
		[
			"the person is away",
			() => {
				goAway("asleep");
			},
		],
	])("sends nothing when %s by the time it is judged", async (_, holding) => {
		const release = holdAnswers();
		await turn(text(CAUSE));
		holding();
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

	it("sends nothing when the window stopped viewing the conversation while it was judged", async () => {
		hasUI = false;
		sessionId = "hosted-1";
		let viewing = true;
		unhost = installHost({
			viewed: (id: string) => viewing && id === "hosted-1",
		} as never);
		const release = holdAnswers();
		await withSession("hosted-1", async () => {
			await turn(text(CAUSE));
		});
		viewing = false;
		release();
		await allJudged();

		expect(judged).toEqual([CAUSE]);
		expect(notes()).toEqual([]);
	});

	it("sends nothing when the guard was switched off while it was judged", async () => {
		const release = holdAnswers();
		await turn(text(CAUSE));
		setSessionMode("untested-cause", "off");
		release();
		await allJudged();

		expect(judged).toEqual([CAUSE]);
		expect(notes()).toEqual([]);
	});

	it.each([
		[
			"two blocks with words between",
			["```", "a", "```", STATUS, "~~~ts", CAUSE, "~~~"],
		],
		[
			"a fence in a list item",
			[STATUS, "", "1. Run:", "", "    ```", `    ${CAUSE}`, "    ```"],
		],
		["a fence left open at the end", [STATUS, "", "```", CAUSE]],
		[
			"a line with words after a fence inside a block",
			["```", "echo", "```bash", CAUSE, "```", "", STATUS],
		],
	])("leaves out code in %s", async (_, lines) => {
		await turn(text(lines.join("\n")));
		await allJudged();

		expect(judged.join("\n")).not.toContain("cache");
		expect(judged.join("\n")).toContain(STATUS);
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

describe("runs before one settle", () => {
	const runStarts = () =>
		handler("agent_start")({ type: "agent_start" }, ctx());
	const runStops = (...messages: object[]) =>
		handler("agent_end")({ type: "agent_end", messages }, ctx());

	it("judge the reply the person was shown last, after words queued behind theirs", async () => {
		await personSays();
		await runStarts();
		await automatedSays();
		await runStops(assistant("stop", text(STATUS)));
		// What was queued runs inside the same stretch, before pi settles.
		await runEnds(assistant("stop", text(CAUSE)));
		await settles();
		await allJudged();

		expect(judged).toEqual([CAUSE]);
	});

	it("judge the reply to the person's queued words, not the run before", async () => {
		await automatedSays();
		await runStarts();
		await input("And why did it fail?", "followUp");
		await runStops(assistant("stop", text(STATUS)));
		await runEnds(assistant("stop", text(CAUSE)));
		await settles();
		await allJudged();

		expect(judged).toEqual([CAUSE]);
	});

	it("judge the run the person's words began after the last run ended, before pi settled", async () => {
		await automatedSays();
		await customBegins();
		await runEnds(assistant("stop", text(STATUS)));
		// A host holds words sent while pi settles until it has.
		await input("Why did the build fail?", "followUp");
		await settles();
		await begins("user");
		await runEnds(assistant("stop", text(CAUSE)));
		await settles();
		await allJudged();

		expect(judged).toEqual([CAUSE]);
	});

	it("judge a run inside the stretch the person's words waited for after the last run ended", async () => {
		await automatedSays();
		await customBegins();
		await runEnds(assistant("stop", text(STATUS)));
		await input("Why did the build fail?", "followUp");
		// pi drains what was queued before it settles.
		await runEnds(assistant("stop", text(CAUSE)));
		await settles();
		await allJudged();

		expect(judged).toEqual([CAUSE]);
	});

	it("judge a run the person's words began from idle, though an automated turn came after them", async () => {
		await input("Why did the build fail?");
		await automatedSays();
		await begins("user");
		await runEnds(assistant("stop", text(CAUSE)));
		await settles();
		await allJudged();

		expect(judged).toEqual([CAUSE]);
	});

	it("judge a run the person steered, though an automated turn began it", async () => {
		await automatedSays();
		await runStarts();
		await input("Why did the build fail?", "steer");
		await runStops(assistant("stop", text(CAUSE)));
		await settles();
		await allJudged();

		expect(judged).toEqual([CAUSE]);
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

	it("is one in a run a peer's steer began", async () => {
		await peerSteers();
		await runEnds(assistant("stop", text(CAUSE)));
		await settles();

		expect(judgments).toEqual([]);
	});

	it("is one in a run a custom message began after the person's words went unanswered by a run", async () => {
		// A handler answered their words itself, starting no run.
		await input("Why did the build fail?");
		await customBegins();
		await runEnds(assistant("stop", text(CAUSE)));
		await settles();

		expect(judgments).toEqual([]);
	});

	it("is one in a run the host continued, though the person's words were handled before it", async () => {
		await input("Why did the build fail?");
		await begins("continue");
		await runEnds(assistant("stop", text(CAUSE)));
		await settles();

		expect(judgments).toEqual([]);
	});

	it("is one in a hosted conversation no window views, which runs in the background", async () => {
		hasUI = false;
		const asked: string[] = [];
		unhost = installHost({
			viewed: (id: string) => {
				asked.push(id);
				return false;
			},
		} as never);
		await withSession(sessionId, async () => {
			await turn(text(CAUSE));
		});

		expect(judgments).toEqual([]);
		expect(asked, "the host is asked of this conversation").toEqual([
			sessionId,
		]);
	});

	it("is one whose judging failed before it began, said once in the log", async () => {
		hasUI = false;
		unhost = installHost({
			viewed: () => {
				throw new Error("the host has gone");
			},
		} as never);
		await withSession(sessionId, async () => {
			await turn(text(CAUSE));
			await turn(text(CAUSE));
		});

		expect(judgments).toEqual([]);
		expect(pi.recorded.entries).toEqual([
			{
				customType: UNJUDGED,
				data: { why: "judging a reply failed", detail: "the host has gone" },
			},
		]);
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
		expect(pi.recorded.entries).toEqual([
			{
				customType: UNJUDGED,
				data: {
					why: "no classifier",
					detail: "no Jev classifier has credentials",
				},
			},
			{ customType: NOTED, data: { parts: 1 } },
		]);
	});

	it("is every one while finding a classifier fails, which the log says once", async () => {
		lookup = async () => {
			throw new Error("the registry is not ready");
		};
		await turn(text(CAUSE));
		await allJudged();
		await turn(text(CAUSE));
		await allJudged();

		expect(lookups).toBe(2);
		expect(judged).toEqual([]);
		expect(notes()).toEqual([]);
		expect(pi.recorded.entries).toEqual([
			{
				customType: UNJUDGED,
				data: {
					why: "finding the classifier failed",
					detail: "the registry is not ready",
				},
			},
		]);
	});

	it("logs what went wrong by its first line, its secrets scrubbed", async () => {
		const token = `github_pat_${"A1".repeat(20)}`;
		lookup = async () => {
			throw new Error(`refused ${token}\nat the registry`);
		};
		await turn(text(CAUSE));
		await allJudged();

		const [entry] = pi.recorded.entries;
		const data = (entry?.data ?? {}) as { detail?: unknown };
		const detail = String(data.detail);
		expect(detail).toContain("refused");
		expect(detail).not.toContain(token);
		expect(detail).not.toContain("at the registry");
	});

	it("waits again on a lookup still out rather than starting another, and judges once it ends", async () => {
		let foundLate: (found: FoundClassifier) => void = () => {};
		lookup = () =>
			new Promise((resolve) => {
				foundLate = resolve;
			});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			await turn(text(CAUSE));
			await vi.advanceTimersByTimeAsync(2500);
			await allJudged();
			await turn(text(CAUSE));
			await vi.advanceTimersByTimeAsync(2500);
			await allJudged();
		} finally {
			vi.useRealTimers();
		}
		foundLate(FOUND);
		await turn(text(CAUSE));
		await allJudged();

		expect(lookups, "one lookup, waited on three times").toBe(1);
		expect(notes()).toHaveLength(1);
		expect(pi.recorded.entries[0]).toEqual({
			customType: UNJUDGED,
			data: { why: "finding the classifier took over 2500 ms" },
		});
	});

	it("lets a lookup go after three replies waited it out, and looks again at the next", async () => {
		lookup = () => new Promise(() => {});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			for (const _ of [1, 2, 3]) {
				await turn(text(CAUSE));
				await vi.advanceTimersByTimeAsync(2500);
				await allJudged();
			}
		} finally {
			vi.useRealTimers();
		}
		expect(lookups, "one lookup, waited on three times").toBe(1);
		lookup = async () => FOUND;
		await turn(text(CAUSE));
		await allJudged();

		expect(lookups).toBe(2);
		expect(notes()).toHaveLength(1);
	});

	it("reads the guard's switch for the conversation the reply is in", async () => {
		hasUI = false;
		sessionId = "hosted-1";
		unhost = installHost({
			viewed: (id: string) => id === "hosted-1",
		} as never);
		await withSession("hosted-1", async () => {
			setSessionMode("untested-cause", "off");
		});
		// Settled under another conversation's context, as a host's
		// emission could be; the reply's own context says hosted-1.
		await withSession("hosted-2", async () => {
			await turn(text(CAUSE));
		});

		expect(judgments).toEqual([]);
	});

	it("still ends quietly when the note can't be sent", async () => {
		pi.sendUserMessage = () => {
			throw new Error("This extension ctx is stale");
		};
		await turn(text(CAUSE));
		await allJudged();

		expect(pi.recorded.entries).toEqual([
			{
				customType: UNJUDGED,
				data: {
					why: "judging a reply or sending its note failed",
					detail: "This extension ctx is stale",
				},
			},
		]);
	});

	it("says nothing went unsent when only the note's record fails", async () => {
		const record = pi.appendEntry.bind(pi);
		pi.appendEntry = (customType: string, data?: unknown) => {
			if (customType === NOTED) throw new Error("the log is full");
			record(customType, data);
		};
		await turn(text(CAUSE));
		await allJudged();

		expect(notes()).toHaveLength(1);
		expect(pi.recorded.entries).toEqual([]);
	});

	it("finds the classifier once across replies once it is found", async () => {
		await turn(text(CAUSE));
		await allJudged();
		await turn(text(STATUS));
		await allJudged();

		expect(lookups).toBe(1);
	});

	it("keeps a classifier switched off, looking for none again", async () => {
		lookup = async () => ({ ok: false, reason: "switched off", off: true });
		await turn(text(CAUSE));
		await allJudged();
		await turn(text(CAUSE));
		await allJudged();

		expect(lookups).toBe(1);
		expect(judged).toEqual([]);
		expect(pi.recorded.entries).toEqual([]);
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
		pi = fakePi();
		install(() =>
			replyClassifier({ PI_MESH_CLASSIFIER: "off" })(registry(asked) as never),
		);
		await turn(text(CAUSE));
		await allJudged();

		expect(asked).toEqual([]);
		expect(notes()).toEqual([]);
	});

	it("reads a hosted conversation's own setting at each lookup", async () => {
		const asked: string[] = [];
		unhost = installHost({
			env: () => ({
				get: (name: string) =>
					name === "PI_MESH_CLASSIFIER" ? "off" : undefined,
			}),
		} as never);
		const found = await replyClassifier()({
			...registry(asked),
			sessionManager: { getSessionId: () => "hosted-1" },
		} as never);

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
