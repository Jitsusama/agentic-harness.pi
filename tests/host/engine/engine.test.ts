/**
 * The engine as the host runs it: each step of a host's life is a node
 * process of its own, sealed from this session's environment, driving
 * createEngine through SessionHost with pi's own runtime, a scripted
 * provider and a probe extension. A folder outlives a step, so the next
 * step plays the host's next start. Runs on a pi built with the host's
 * patches, named by PI_HOST_PACKAGE_DIR; without one it is skipped.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const packageDir = process.env.PI_HOST_PACKAGE_DIR;
const FIXTURE = join(import.meta.dirname, "fixtures", "hosted-engine.mts");
/** A few host starts in a row, each loading pi's whole package. */
const HOST_LIFE_MS = 90_000;

interface Seen {
	readonly sessionId?: string;
	readonly sameId?: boolean;
	readonly file?: string | boolean;
	readonly transcript?: readonly string[];
	readonly state?: string;
	readonly after?: string;
	readonly keysSeen: readonly string[];
	readonly ran: number;
	readonly probe: readonly Record<string, string>[];
	readonly reported: readonly string[];
}

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

/** A host's folder, with a home, runtime folder and temp folder of its own. */
function hostFolder(): string {
	const folder = mkdtempSync(join(tmpdir(), "hosted-engine-"));
	folders.push(folder);
	for (const name of ["home", "run", "tmp"])
		mkdirSync(join(folder, name), { recursive: true });
	return folder;
}

/** A step's environment: none of this session's pi or credentials, and a home inside its folder. */
function sealedEnv(folder: string): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		HOME: join(folder, "home"),
		XDG_RUNTIME_DIR: join(folder, "run"),
		TMPDIR: join(folder, "tmp"),
	};
}

function args(folder: string, scenario: string): string[] {
	if (!packageDir) throw new Error("PI_HOST_PACKAGE_DIR names no package");
	return ["--no-warnings", FIXTURE, packageDir, folder, scenario];
}

/** One step of a host's life, and what it printed. */
async function step(folder: string, scenario: string): Promise<Seen> {
	const { stdout } = await run(process.execPath, args(folder, scenario), {
		env: sealedEnv(folder),
	});
	return JSON.parse(stdout);
}

/** A step that dies of a signal; answers the signal. */
async function killedStep(
	folder: string,
	scenario: string,
): Promise<string | null> {
	try {
		await run(process.execPath, args(folder, scenario), {
			env: sealedEnv(folder),
		});
		return null;
	} catch (error) {
		if (error instanceof Error && "signal" in error)
			return typeof error.signal === "string" ? error.signal : null;
		throw error;
	}
}

describe.runIf(packageDir !== undefined)("the host's engine", () => {
	it(
		"answers a conversation's first words with the conversation's own key, and closes it",
		async () => {
			const seen = await step(hostFolder(), "open");
			expect(
				seen.sameId,
				"pi's session is the conversation the host named",
			).toBe(true);
			expect(seen.transcript).toEqual([
				"system: ",
				"user: hi",
				"assistant: hello there",
			]);
			expect(seen.keysSeen).toEqual(["first-key"]);
			expect(seen.state).toBe("idle");
			expect(seen.after).toBe("gone");
			expect(seen.probe).toEqual([
				{ event: "session_start", reason: "startup" },
				{ event: "stamp", how: "closed" },
				{ event: "session_shutdown", reason: "quit" },
			]);
			expect(seen.reported).toEqual([]);
		},
		HOST_LIFE_MS,
	);

	it(
		"sends a refused request once more on a renewed key",
		async () => {
			const seen = await step(hostFolder(), "renew");
			expect(seen.keysSeen).toEqual(["first-key", "second-key"]);
			expect(seen.transcript).toEqual([
				"system: ",
				"user: hi",
				"assistant: hello again",
			]);
		},
		HOST_LIFE_MS,
	);

	it(
		"keeps a conversation never answered, and resumes it under its own id",
		async () => {
			const folder = hostFolder();
			const quiet = await step(folder, "open-quiet");
			expect(quiet.file, "pi's file is kept before any answer").toBe(true);
			expect(quiet.probe.at(-2)).toEqual({ event: "stamp", how: "signalled" });
			const resumed = await step(folder, "resume");
			expect(resumed.sameId, "the resumed session keeps its id").toBe(true);
			expect(resumed.transcript).toEqual([
				"system: ",
				"user: are you there",
				"assistant: after the restart",
			]);
		},
		HOST_LIFE_MS,
	);

	it(
		"carries on a conversation whose host was killed mid-tool, running the tool once",
		async () => {
			const folder = hostFolder();
			expect(await killedStep(folder, "crash")).toBe("SIGKILL");
			const resumed = await step(folder, "resume");
			expect(resumed.ran).toBe(1);
			expect(resumed.transcript).toEqual([
				"system: ",
				"user: run it",
				"assistant: [toolCall]",
				"toolResult: Tool bash was interrupted by a restart and may have partially run",
				"assistant: after the restart",
				"user: are you there",
				"assistant: and again",
			]);
			const ordinary = await step(folder, "reopen");
			expect(ordinary.sessionId).toBe(resumed.sessionId);
			expect(ordinary.transcript).toEqual(resumed.transcript);
		},
		HOST_LIFE_MS,
	);
});
