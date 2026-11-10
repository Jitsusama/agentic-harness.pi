/**
 * The hosted agent against pi's own: each scenario runs the same session,
 * scripted provider and inputs once on pi's Agent and once on the host's,
 * and pi's listeners must see the same events with the same payloads, and
 * the agent end with the same transcript. Each run is its own node process,
 * so pi's modules load once, as pi's, and the engine loads as the host loads
 * it. Runs on a pi built with the host's patches, named by
 * PI_HOST_PACKAGE_DIR; without one it is skipped, as nothing else carries
 * the seams. tests/host/engine/README.md gives the command that runs it.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const packageDir = process.env.PI_HOST_PACKAGE_DIR;
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
	if (!packageDir) throw new Error("PI_HOST_PACKAGE_DIR names no package");
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
} as const;

describe.runIf(packageDir !== undefined)(
	"the hosted agent, beside pi's",
	{ timeout: SESSION_PAIR_MS },
	() => {
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
			});
		}
	},
);

describe.runIf(packageDir !== undefined)(
	"the hosted agent after SIGKILL mid-tool",
	{ timeout: SESSION_PAIR_MS },
	() => {
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
	},
);
