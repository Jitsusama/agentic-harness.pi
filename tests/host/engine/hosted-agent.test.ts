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
import { hostPiFor } from "../end-to-end/support/host-pi.ts";

const run = promisify(execFile);
/** The host's pi, found again for each case, which skips or fails without one. */
let packageDir = "";
beforeEach(({ skip }) => {
	packageDir = hostPiFor(skip);
});
const FIXTURE = join(import.meta.dirname, "fixtures", "hosted-session.mts");
/** Two sessions in two processes, each loading pi's whole package. */
const SESSION_PAIR_MS = 60_000;

interface Observed {
	readonly events: readonly { readonly type: string }[];
	readonly transcript: readonly {
		readonly role: string;
		readonly content: unknown;
	}[];
	/** How many times the scenario's tool really ran, for a kept session. */
	readonly ran?: number;
}

/** A child's environment: none of this session's pi or credentials, only what node needs. */
function sealedEnv(): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		TMPDIR: process.env.TMPDIR ?? "",
	};
}

function fixtureArgs(
	mode: "pi" | "hosted",
	scenario: string,
	folder?: string,
): string[] {
	return [
		"--no-warnings",
		FIXTURE,
		packageDir,
		mode,
		scenario,
		...(folder ? [folder] : []),
	];
}

/** What pi's listeners saw in one scenario, on pi's agent or the host's. */
async function observe(
	mode: "pi" | "hosted",
	scenario: string,
	folder?: string,
): Promise<Observed> {
	const { stdout } = await run(
		process.execPath,
		fixtureArgs(mode, scenario, folder),
		{ env: sealedEnv() },
	);
	return JSON.parse(stdout);
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

/** Run a hosted scenario to its death, keeping what it left in `folder`; answers the signal that ended it. */
async function killed(
	scenario: string,
	folder: string,
): Promise<string | null> {
	try {
		await run(process.execPath, fixtureArgs("hosted", scenario, folder), {
			env: sealedEnv(),
		});
		return null;
	} catch (error) {
		const signal =
			typeof error === "object" && error !== null && "signal" in error
				? error.signal
				: null;
		return typeof signal === "string" ? signal : null;
	}
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
} as const;

/** A message's text, its parts joined. */
function textOf(message: { readonly content: unknown }): string {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: unknown) => {
			const text: unknown =
				typeof part === "object" && part !== null
					? Reflect.get(part, "text")
					: undefined;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

function said(observed: Observed, role: string): string[] {
	return observed.transcript
		.filter((message) => message.role === role)
		.map(textOf);
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
			expect(observed.ran, "the tool ran once, before the kill").toBe(1);
			expect(observed.events.at(-1)?.type).toBe("agent_end");
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});
});
