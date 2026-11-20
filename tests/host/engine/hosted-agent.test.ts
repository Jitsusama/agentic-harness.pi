/**
 * The hosted agent against pi's own: each scenario runs the same session,
 * scripted provider and inputs once on pi's Agent and once on the host's,
 * and pi's listeners must see the same events with the same payloads, and
 * the agent end with the same transcript. Each run is its own node process,
 * so pi's modules load once, as pi's, and the engine loads as the host loads
 * it. Runs on a pi built with the host's patches, since nothing else
 * carries the seams, found as tests/host/end-to-end/support/host-pi.ts
 * finds it; without one each case is skipped saying how to get one, and
 * fails under `pnpm test:host`. tests/host/engine/README.md says more.
 * Long because its scenarios share one paired harness, each a run on
 * pi's agent and on the host's compared event by event, and read as one
 * account of where the two must agree.
 */
import { execFile } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { isRefusedRun } from "../../../lib/internal/session/cut-off-record.ts";
import { hostPiFor } from "../end-to-end/support/host-pi.ts";
import {
	type Observed,
	said,
	sealedEnv,
	sessionRuns,
	textOf,
} from "./fixtures/session-runs.ts";

const run = promisify(execFile);
/** The host's pi, found again for each case, which skips or fails without one. */
let packageDir = "";
beforeEach(({ skip }) => {
	packageDir = hostPiFor(skip);
});
const { fixtureArgs, observe, killed } = sessionRuns(() => packageDir);
/** Two sessions in two processes, each loading pi's whole package. */
const SESSION_PAIR_MS = 60_000;
/** The longest a park may hold a stopping host's close, whatever the provider does. */
const PARKED_CLOSE_MOST_MS = 5_000;

/** The turns a run took and gave back, among the ends of pi's runs and any other events named. */
function turnsOf(observed: Observed, among: readonly string[] = []): unknown[] {
	return observed.events.flatMap((event): unknown[] => {
		if (event.type === "agent_end" || among.includes(event.type))
			return [event.type];
		if (event.type === "turn" || event.type === "turn asked")
			return [{ type: event.type, waits: event.waits }];
		if (event.type === "turn given back") return [{ type: event.type }];
		return [];
	});
}

/** What pi's listeners saw opening a kept session on the host's agent, and what durable reported meanwhile. */
async function reopenedWithReports(
	folder: string,
	scenario = "reopen",
): Promise<{ readonly observed: Observed; readonly reported: string }> {
	const { stdout, stderr } = await run(
		process.execPath,
		fixtureArgs("hosted", scenario, folder),
		{ env: sealedEnv() },
	);
	return { observed: JSON.parse(stdout), reported: stderr };
}

/**
 * Rewrite the session `folder` keeps: `edit` may change each message in
 * place, and the entry is dropped where it answers false.
 */
function doctorSession(
	folder: string,
	edit: (message: Record<string, unknown>) => boolean,
): void {
	const sessions = join(folder, "sessions");
	for (const file of readdirSync(sessions)) {
		const path = join(sessions, file);
		const kept = readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				const entry: unknown = JSON.parse(line);
				const message = isRecord(entry) ? entry.message : undefined;
				return isRecord(message) && !edit(message)
					? []
					: [JSON.stringify(entry)];
			});
		writeFileSync(path, `${kept.join("\n")}\n`);
	}
}

/** Whether `message` is an answer calling `callId`. */
function calls(message: Record<string, unknown>, callId: string): boolean {
	return (
		message.role === "assistant" &&
		Array.isArray(message.content) &&
		message.content.some((part) => isRecord(part) && part.id === callId)
	);
}

/** What the session file in `folder` holds around its custom message, in file order: the entry before it and the one after. */
function besideTheWord(folder: string): [string, string] {
	const sessions = join(folder, "sessions");
	const said = readdirSync(sessions).flatMap((file) =>
		readFileSync(join(sessions, file), "utf8")
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				const entry: unknown = JSON.parse(line);
				if (!isRecord(entry)) return [];
				if (entry.type === "custom_message") return ["the word"];
				const message = entry.message;
				if (entry.type !== "message" || !isRecord(message)) return [];
				if (message.role === "toolResult")
					return [`the result of ${String(message.toolCallId)}`];
				if (calls(message, "call-2")) return ["the call of call-2"];
				return [String(message.role)];
			}),
	);
	const word = said.indexOf("the word");
	return [said[word - 1] ?? "nothing", said[word + 1] ?? "nothing"];
}

const SCENARIOS = {
	plain: "answers a prompt",
	tool: "runs a tool round",
	steer: "places a steer made mid-round before the next request",
	"follow-up": "runs a follow-up once the turn ends",
	error: "ends the run on a provider's error",
	"abort-in-tool": "aborts in a tool and ends on the provider's aborted answer",
	"abort-in-stream": "aborts mid-stream",
	"two-prompts": "answers a second prompt on the first one's history",
	"unknown-tool":
		"fails an unknown tool and invalid arguments with pi's texts, in call order",
	truncated: "fails a call cut off at the output limit and continues",
	routed:
		"sends each request to the model a virtual model's router picks for it",
	retry: "retries a provider's passing error by continuing the run",
	overflow: "compacts on a context overflow and continues",
	branch: "answers on the branch the session went back to",
	"job-result":
		"settles each run pi starts once, a job's result said after it as its own turn",
} as const;

/** The ends of pi's runs and the settles its extensions heard, in order. */
function endsOf(observed: Observed): string[] {
	return observed.events
		.map((event) => event.type)
		.filter((type) => type === "agent_end" || type === "agent_settled");
}

/** What an outbox noted once its result was said, or its wait ended. */
function outboxOf(observed: Observed): unknown {
	const outbox = observed.events.find((event) => event.type === "outbox");
	return {
		sends: Reflect.get(outbox ?? {}, "sends"),
		waiting: Reflect.get(outbox ?? {}, "waiting"),
	};
}

/** Whether an event carries a message whose text is `text`. */
function carries(event: object, text: string): boolean {
	const message: unknown = Reflect.get(event, "message");
	return isRecord(message) && textOf({ content: message.content }) === text;
}

/** The provider errors a transcript holds, by their text. */
function refusals(observed: Observed): unknown[] {
	return observed.transcript
		.filter(
			(message) =>
				message.role === "assistant" &&
				Reflect.get(message, "stopReason") === "error",
		)
		.map((message) => Reflect.get(message, "errorMessage"));
}

/**
 * What a scenario's transcript must show beyond matching pi's, so a run
 * in which neither agent did the thing can't pass.
 */
const SHOWN: Partial<
	Record<
		keyof typeof SCENARIOS,
		{ readonly what: (observed: Observed) => unknown; readonly is: unknown }
	>
> = {
	routed: {
		what: (observed) =>
			observed.transcript
				.filter((message) => message.role === "assistant")
				.map((message) => Reflect.get(message, "model")),
		is: ["faux-small", "faux-large"],
	},
	retry: {
		what: (observed) => said(observed, "assistant").at(-1),
		is: "recovered",
	},
	overflow: {
		what: (observed) => said(observed, "assistant").at(-1),
		is: "after compacting",
	},
	branch: {
		what: (observed) => said(observed, "user"),
		is: ["first", "third"],
	},
	"job-result": {
		what: (observed) => ({
			ends: endsOf(observed),
			outbox: outboxOf(observed),
		}),
		is: {
			ends: ["agent_end", "agent_settled", "agent_end", "agent_settled"],
			outbox: { sends: 1, waiting: 0 },
		},
	},
};

describe("the hosted agent, beside pi's", { timeout: SESSION_PAIR_MS }, () => {
	for (const [scenario, behaviour] of Object.entries(SCENARIOS)) {
		it(behaviour, async () => {
			const [ours, hosted] = await Promise.all([
				observe("pi", scenario),
				observe("hosted", scenario),
			]);
			expect(
				hosted,
				`the host's agent shows pi's listeners what pi's own does (${scenario})`,
			).toEqual(ours);
			const shown = Object.entries(SHOWN).find(([name]) => name === scenario);
			if (shown)
				expect(shown[1].what(hosted), `what ${scenario} shows`).toEqual(
					shown[1].is,
				);
		});
	}
});

describe("the hosted agent after SIGKILL mid-tool", {
	timeout: SESSION_PAIR_MS,
}, () => {
	it("carries the conversation on without running the tool again, in a file ordinary pi opens", async () => {
		const folder = mkdtempSync(join(tmpdir(), "hosted-crash-"));
		try {
			expect(
				await killed("crash-in-tool", folder),
				"the host died in its tool",
			).toBe("SIGKILL");
			const reopened = await observe("hosted", "reopen", folder);
			expect(
				reopened.ran,
				"the tool ran once, before the kill, and never again",
			).toBe(1);
			expect(
				reopened.transcript.map((message) => message.role),
				"the interrupted call has its result and the conversation its next answer",
			).toEqual(["system", "user", "assistant", "toolResult", "assistant"]);
			expect(
				JSON.stringify(reopened.transcript[3]?.content),
				"the result says what happened",
			).toContain("was interrupted by a restart");
			expect(
				reopened.events.at(-1)?.type,
				"pi saw the carried-on run end",
			).toBe("agent_end");
			const ordinary = await observe("pi", "inspect", folder);
			expect(
				ordinary.transcript,
				"ordinary pi opens the session file to the same transcript",
			).toEqual(reopened.transcript);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});
});

describe("the hosted agent continued once durable's session closed", {
	timeout: SESSION_PAIR_MS,
}, () => {
	it.each([
		["asking the model again", "continue-closed"],
		["running words pi queued to steer", "continue-closed-steered"],
		["running words pi queued to follow up", "continue-closed-followed"],
	])(
		"throws what refused it once its run has ended, %s, so pi's loop ends rather than asking again forever",
		async (_branch, scenario) => {
			const observed = await observe("hosted", scenario);
			const continued = observed.events.find(
				(event) => event.type === "continued",
			);
			expect(continued?.error, "the continue threw the refusal").toBe(
				"Session is closed",
			);
			expect(continued?.streaming, "a run still under way").toBe(false);
			const ends = observed.events.flatMap((event) =>
				event.type === "message_end" ? [Reflect.get(event, "message")] : [],
			);
			const answers = ends.filter(
				(message) => isRecord(message) && message.role === "assistant",
			);
			// The job workflow reads a carried run's end past this mark.
			expect(
				answers.map((message) => isRefusedRun(message)),
				"only the answer to the run never admitted is marked the host's",
			).toEqual([false, true]);
			const logged = (observed.logged ?? []).filter(
				(message) => isRecord(message) && message.role === "assistant",
			);
			expect(
				logged.map((message) => isRefusedRun(message)),
				"the mark kept in the log the job workflow reads",
			).toEqual([false, true]);
		},
	);
});

describe("the hosted agent parked before a slow first token", {
	timeout: SESSION_PAIR_MS,
}, () => {
	it("lets the host close at once, though the provider pays the abort no heed", async () => {
		const observed = await observe("hosted", "park-slow-first-token");
		const closed = observed.events.find((event) => event.type === "closed");
		expect(closed, "the fixture timed the close").toBeDefined();
		expect(
			closed?.ms,
			"the close waited on no answer the park had abandoned",
		).toBeLessThan(PARKED_CLOSE_MOST_MS);
	});
});

/**
 * Two shapes a restart left on 13 November, when a host's planned restart
 * cut off nineteen conversations mid-turn and their resumes threw.
 */
describe("the hosted agent resuming a turn a restart cut off", {
	timeout: SESSION_PAIR_MS,
}, () => {
	it("closes a turn whose answer and result pi showed, durable never hearing what follows", async () => {
		// One helper held its tool's result with no answer after it, and its resume was refused as a turn never answered.
		const folder = mkdtempSync(join(tmpdir(), "hosted-turn-end-"));
		try {
			expect(await killed("crash-at-turn-end", folder)).toBe("SIGKILL");
			const { observed, reported } = await reopenedWithReports(folder);
			expect(reported, "durable reported nothing").toBe("");
			expect(
				observed.transcript.map((message) => message.role),
				"the turn closed and the conversation had its next answer",
			).toEqual(["system", "user", "assistant", "toolResult", "assistant"]);
			expect(said(observed, "assistant").at(-1)).toBe("after the restart");
			expect(observed.ran, "the tool ran once, before the kill").toBe(1);
			expect(observed.events.at(-1)?.type).toBe("agent_end");
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("asks the model again for a turn the host stopped mid-request", async () => {
		// On 14 November a reboot cut a request off; durable, its retry left to pi, ended the carried run as interrupted, and the conversation sat unanswered until a peer's word woke it.
		const folder = mkdtempSync(join(tmpdir(), "hosted-request-"));
		try {
			expect(await killed("crash-in-request", folder)).toBe("SIGKILL");
			const { observed, reported } = await reopenedWithReports(folder);
			expect(
				reported.trim(),
				"durable reported only the request the host cut off",
			).toBe(
				"durable reported: Error: The host stopped while the model was answering, on attempt 1",
			);
			expect(
				said(observed, "assistant").at(-1),
				"the cut-off turn has its answer",
			).toBe("after the restart");
			expect(
				observed.transcript.at(-1)?.role,
				"the conversation ends on that answer",
			).toBe("assistant");
			expect(observed.events.at(-1)?.type).toBe("agent_end");
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("carries a cut-off tool round on in a turn, first as words typed began it, given back as its first answer ends", async () => {
		// After a restart every resumed run went at once (WCJQSG, 15 November); each now takes one of a few turns.
		const folder = mkdtempSync(join(tmpdir(), "hosted-turn-"));
		try {
			expect(await killed("crash-in-tool", folder)).toBe("SIGKILL");
			const reopened = await observe("hosted", "reopen-taking-turns", folder);
			expect(turnsOf(reopened)).toEqual([
				{ type: "turn", waits: "began" },
				{ type: "turn given back" },
				"agent_end",
			]);
			expect(reopened.ran, "the tool ran once, before the kill").toBe(1);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("gives the turn back as a carried run busy past its first answer goes on, so it holds up no other", async () => {
		// A builder's run can go on for an hour; held to its end, the runs behind it and words sent to them would wait as long (OSPHT4, 15 November).
		const folder = mkdtempSync(join(tmpdir(), "hosted-turn-busy-"));
		try {
			expect(await killed("crash-in-tool", folder)).toBe("SIGKILL");
			const reopened = await observe(
				"hosted",
				"reopen-taking-turns-busy",
				folder,
			);
			expect(
				turnsOf(reopened, ["tool_execution_start"]),
				"the cut-off round shows first; the turn goes back as the answer after it ends, before that answer's tool starts",
			).toEqual([
				{ type: "turn", waits: "began" },
				"tool_execution_start",
				{ type: "turn given back" },
				"tool_execution_start",
				"agent_end",
			]);
			expect(
				said(reopened, "assistant").at(-1),
				"the run went on to its end without the turn",
			).toBe("after the restart");
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("gives the turn of a run a request was cut off in back as the ask again's answer ends", async () => {
		const folder = mkdtempSync(join(tmpdir(), "hosted-turn-request-"));
		try {
			expect(await killed("crash-in-request-automated", folder)).toBe(
				"SIGKILL",
			);
			const { observed } = await reopenedWithReports(
				folder,
				"reopen-taking-turns",
			);
			expect(
				turnsOf(observed),
				"a turn the harness began waits behind Joel's; the carried run showed pi nothing, and the ask again's answer gives the turn back",
			).toEqual([
				{ type: "turn", waits: "not" },
				{ type: "turn given back" },
				"agent_end",
			]);
			expect(said(observed, "assistant").at(-1)).toBe("after the restart");
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("answers words typed while a run a request was cut off in waits for its turn, the ask again's answer first", async () => {
		// pi's session continued into the ask again's run and was told the agent was already processing (15 November).
		const folder = mkdtempSync(join(tmpdir(), "hosted-turn-typed-"));
		try {
			expect(await killed("crash-in-request-automated", folder)).toBe(
				"SIGKILL",
			);
			const { observed } = await reopenedWithReports(
				folder,
				"reopen-typed-while-waiting",
			);
			expect(
				turnsOf(observed).slice(0, 2),
				"the run asked behind Joel's runs and, once his words were in, ranked as one he types into",
			).toEqual([
				{ type: "turn asked", waits: "not" },
				{ type: "turn", waits: "typing" },
			]);
			expect(
				said(observed, "assistant"),
				"the cut-off request and the words are both answered",
			).toEqual(["after the restart", "and your words"]);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("moves a run waiting for its turn up once Joel steers into it", async () => {
		// On 19 November Joel's steer into a carried turn waited for every other run of the start.
		const folder = mkdtempSync(join(tmpdir(), "hosted-turn-steered-"));
		try {
			expect(await killed("crash-in-request-automated", folder)).toBe(
				"SIGKILL",
			);
			const { observed } = await reopenedWithReports(
				folder,
				"reopen-steered-while-waiting",
			);
			expect(
				turnsOf(observed).slice(0, 2),
				"the run asked behind Joel's runs and, once his steer was in, counted as his",
			).toEqual([
				{ type: "turn asked", waits: "not" },
				{ type: "turn", waits: "typing" },
			]);
			expect(
				said(observed, "assistant"),
				"the cut-off request and the steer are both answered",
			).toEqual(["after the restart", "and your words"]);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("leaves a waiting run where it was when a peer agent steers into it", async () => {
		// A peer's steer carries no automated header, so it read as Joel's and could jump a start's turns (council, 19 November).
		const folder = mkdtempSync(join(tmpdir(), "hosted-turn-peer-"));
		try {
			expect(await killed("crash-in-request-automated", folder)).toBe(
				"SIGKILL",
			);
			const { observed } = await reopenedWithReports(
				folder,
				"reopen-peer-steered-while-waiting",
			);
			expect(
				turnsOf(observed).slice(0, 2),
				"the peer's steer is in, yet the run still ranks as none Joel waits on",
			).toEqual([
				{ type: "turn asked", waits: "not" },
				{ type: "turn", waits: "not" },
			]);
			expect(
				said(observed, "assistant"),
				"the cut-off request and the peer's steer are both answered",
			).toEqual(["after the restart", "and your words"]);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	// 15 November's soak: a job begun in a run a restart cut off reported only once a person typed, its conversation listed busy meanwhile. The host's own runs told extensions they began and never that they settled, so job-workflow's outbox waited on a settle that never came.
	for (const [crash, carried] of [
		["crash-in-tool", "a carried tool round"],
		["crash-in-request-automated", "an ask again"],
	] as const) {
		it(`says a job's result that comes after ${carried} ends as its own turn, each run settled once`, async () => {
			const folder = mkdtempSync(join(tmpdir(), "hosted-job-after-"));
			try {
				expect(await killed(crash, folder)).toBe("SIGKILL");
				const { observed } = await reopenedWithReports(
					folder,
					"reopen-job-reports-after",
				);
				expect(
					endsOf(observed),
					"the carried run settles as it ends, and the result's run settles once",
				).toEqual(["agent_end", "agent_settled", "agent_end", "agent_settled"]);
				expect(
					outboxOf(observed),
					"the result went once and left the outbox",
				).toEqual({ sends: 1, waiting: 0 });
				expect(
					said(observed, "assistant").slice(-2),
					"the carried turn's answer, then the result's",
				).toEqual(["after the restart", "and the job's result"]);
			} finally {
				rmSync(folder, { recursive: true, force: true });
			}
		});
	}

	it("takes no turn for a conversation with nothing to carry on", async () => {
		const fresh = await observe("hosted", "fresh-taking-turns");
		expect(turnsOf(fresh)).toEqual(["agent_end"]);
	});

	it("shows the answer pi never saw without showing again a result it held under another time", async () => {
		// Another held its first result 1 ms off durable's, and not the answer after it; the resume showed the result again and broke that answer's round.
		const folder = mkdtempSync(join(tmpdir(), "hosted-second-tool-"));
		try {
			expect(await killed("crash-in-second-tool", folder)).toBe("SIGKILL");
			doctorSession(folder, (message) => {
				if (
					message.role === "toolResult" &&
					message.toolCallId === "call-1" &&
					typeof message.timestamp === "number"
				)
					message.timestamp -= 1;
				return !calls(message, "call-2");
			});
			const { observed, reported } = await reopenedWithReports(folder);
			expect(reported, "durable reported nothing").toBe("");
			expect(
				observed.transcript.map((message) => message.role),
				"each result shown once, after its answer",
			).toEqual([
				"system",
				"user",
				"assistant",
				"toolResult",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(textOf(observed.transcript[5] ?? { content: "" })).toContain(
				"was interrupted by a restart",
			);
			expect(said(observed, "assistant").at(-1)).toBe("after the restart");
			expect(observed.ran, "each tool ran once, before the kill").toBe(2);
			expect(observed.events.at(-1)?.type).toBe("agent_end");
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("writes a peer's word sent mid-round after the round's result, as pi does in a run of its own", async () => {
		// Two had a mesh message written between a call and its result, and every request after was refused for a result without its call.
		const folder = mkdtempSync(join(tmpdir(), "hosted-word-"));
		try {
			expect(await killed("crash-in-tool", folder)).toBe("SIGKILL");
			const { observed, reported } = await reopenedWithReports(
				folder,
				"reopen-with-a-word",
			);
			expect(reported, "durable reported nothing").toBe("");
			expect(
				besideTheWord(folder),
				"the word follows the round's result in the file",
			).toEqual(["the result of call-2", "assistant"]);
			expect(refusals(observed), "no request was refused").toEqual([]);
			expect(said(observed, "assistant").at(-1)).toBe("after the word");
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("writes a peer's word held mid-round when the host stops before the round ends", async () => {
		// A host stops in the middle of such turns, and a word held only in memory would be lost without a word.
		const folder = mkdtempSync(join(tmpdir(), "hosted-word-stopped-"));
		try {
			expect(await killed("crash-in-tool", folder)).toBe("SIGKILL");
			expect(
				await killed("reopen-with-a-word-stopped", folder),
				"the host stopped of itself",
			).toBeNull();
			expect(
				besideTheWord(folder),
				"the word is in the file, after the call it came during",
			).toEqual(["the call of call-2", "nothing"]);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("answers on a file that holds a word between a call and its result, now and on the next turn", async () => {
		// The two conversations of 13 November hold their files in this shape still.
		const folder = mkdtempSync(join(tmpdir(), "hosted-word-written-"));
		try {
			expect(await killed("crash-in-tool", folder)).toBe("SIGKILL");
			const { observed, reported } = await reopenedWithReports(
				folder,
				"reopen-with-a-word-written",
			);
			expect(reported, "durable reported nothing").toBe("");
			expect(
				besideTheWord(folder),
				"the word sits between the call and its result",
			).toEqual(["the call of call-2", "the result of call-2"]);
			expect(refusals(observed), "no request was refused").toEqual([]);
			expect(said(observed, "assistant").at(-1)).toBe("after the word");
			const next = await reopenedWithReports(folder, "reopen-asked");
			expect(
				refusals(next.observed),
				"the next turn, on the file as it was left, was not refused",
			).toEqual([]);
			expect(said(next.observed, "assistant").at(-1)).toBe("answered");
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("carries on the cut-off turn, then the prompt an extension sent as it started", async () => {
		// A third began a run as its session started, before the recovery, and the recovery was refused as the agent already processing; durable refused the prompt as busy, and its words were lost.
		const folder = mkdtempSync(join(tmpdir(), "hosted-prompted-"));
		try {
			expect(await killed("crash-in-tool", folder)).toBe("SIGKILL");
			const { observed, reported } = await reopenedWithReports(
				folder,
				"reopen-prompted",
			);
			expect(reported, "durable reported nothing").toBe("");
			expect(
				observed.transcript.some(
					(message) =>
						message.role === "toolResult" &&
						textOf(message).includes("was interrupted"),
				),
				"the cut-off call has its result",
			).toBe(true);
			expect(
				said(observed, "assistant"),
				"the call, the cut-off turn's end and the prompt's answer, none refused as busy",
			).toEqual(["", "after the restart", "and the prompt"]);
			expect(said(observed, "user").at(-1)).toBe("sent at the start");
			const types = observed.events.map((event) => event.type);
			const carriedOnEnd = observed.events.findIndex(
				(event) =>
					event.type === "message_end" && carries(event, "after the restart"),
			);
			expect(
				types,
				"the prompt's words were queued while the carried-on turn ran",
			).toContain("queued_mid_turn");
			expect(
				types.indexOf("queued_mid_turn"),
				"queued before the carried-on turn answered",
			).toBeLessThan(carriedOnEnd);
			// A runtime built before the seam shows them nowhere, as before; the host says so at start.
			const shows = !observed.lacking?.includes(
				"pi-host-agent-interface.patch",
			);
			expect(
				Reflect.get(
					observed.events.find((event) => event.type === "queued_mid_turn") ??
						{},
					"pending",
				),
				"the queued words show as pending while the carried-on turn runs",
			).toEqual(shows ? ["sent at the start"] : []);
			expect(
				observed.pendingAtEnd,
				"nothing stays pending once its turn started",
			).toEqual([]);
			expect(observed.ran, "the tool ran once, before the kill").toBe(1);
			expect(observed.events.at(-1)?.type).toBe("agent_end");
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("queues a prompt sent while the recovery carries a turn on behind it, rather than refusing it", async () => {
		// On 14 November job-workflow said a cut-off notice while the recovery ran; pi, idle by its own account, began a run each time, the agent refused it as already processing, and the notice went again at once, about every 1.2 s for a minute.
		// The carried turn is now pi's own run, so words typed into it go to pi's queue as its editor sends them, and pi hands them to the agent to keep: what keeps Joel's words.
		const folder = mkdtempSync(join(tmpdir(), "hosted-prompted-during-"));
		try {
			expect(await killed("crash-in-tool", folder)).toBe("SIGKILL");
			const { observed, reported } = await reopenedWithReports(
				folder,
				"reopen-prompted-during",
			);
			expect(reported, "durable reported nothing").toBe("");
			// A runtime built before the seam carries the turn on outside pi's run, where the agent queues the words itself.
			const inPiRun = !observed.lacking?.includes(
				"pi-host-runs-through-pi.patch",
			);
			expect(
				observed.events.find((event) => event.type === "prompted")?.streaming,
				"sent into pi's run where pi has the seam, so through pi's own queue",
			).toBe(inPiRun);
			expect(
				observed.events.filter((event) => event.type === "prompt_refused"),
				"the prompt was not refused",
			).toEqual([]);
			expect(
				said(observed, "assistant"),
				"the call, the cut-off turn's end and the prompt's answer",
			).toEqual(["", "after the restart", "and the prompt"]);
			expect(said(observed, "user").at(-1)).toBe("sent during the turn");
			expect(
				observed.events.map((event) => event.type),
				"the prompt's words were queued while the carried-on turn ran",
			).toContain("queued_mid_turn");
			expect(
				observed.events.map((event) => event.type),
				"an open waiting on those words heard durable held them, though no prompt committed them",
			).toContain("words_held");
			expect(observed.ran, "the tool ran once, before the kill").toBe(1);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("says a cut-off notice through job-workflow's outbox once while the recovery carries a turn on", async () => {
		// On 14 November two conversations sent theirs 335 and 233 times, each a run pi began and the agent refused, holding their host's start for about a minute.
		const folder = mkdtempSync(join(tmpdir(), "hosted-noticed-during-"));
		try {
			expect(await killed("crash-in-tool", folder)).toBe("SIGKILL");
			const { observed, reported } = await reopenedWithReports(
				folder,
				"reopen-noticed-during",
			);
			expect(reported, "durable reported nothing").toBe("");
			const refused = observed.events.filter(
				(event) => event.type === "prompt_refused",
			);
			const outbox = observed.events.find((event) => event.type === "outbox");
			expect(
				{
					refused: refused.length,
					sends: Reflect.get(outbox ?? {}, "sends"),
					waiting: Reflect.get(outbox ?? {}, "waiting"),
				},
				"the notice went once, was not refused and left the outbox",
			).toEqual({ refused: 0, sends: 1, waiting: 0 });
			expect(
				said(observed, "user").filter((text) => text.includes("[cut-off]")),
				"the conversation holds the notice once",
			).toHaveLength(1);
			expect(
				said(observed, "assistant"),
				"the call, the cut-off turn's end and the notice's answer",
			).toEqual(["", "after the restart", "and the notice"]);
			expect(observed.ran, "the tool ran once, before the kill").toBe(1);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});
});
