/**
 * The engine as the host runs it: each step of a host's life is a node
 * process of its own, sealed from this session's environment, driving
 * createEngine through SessionHost with pi's own runtime, a scripted
 * provider and a probe extension. A folder outlives a step, so the next
 * step plays the host's next start. Runs on a pi built with the host's
 * patches, named by PI_HOST_PACKAGE_DIR; without one it is skipped.
 * tests/host/engine/README.md gives the command that runs it.
 */
import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const packageDir = process.env.PI_HOST_PACKAGE_DIR;
const FIXTURE = join(import.meta.dirname, "fixtures", "hosted-engine.mts");
/** The entry script a pi install's package names as its pi command. */
function piBin(root: string): string {
	const manifest: { bin?: { pi?: string } } = JSON.parse(
		readFileSync(join(root, "package.json"), "utf8"),
	);
	return manifest.bin?.pi ?? "";
}

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
	readonly childrenAlive: readonly number[];
	readonly probe: readonly Record<string, string>[];
	/** The subagent install the probe extension found each time it loaded. */
	readonly installs: readonly {
		readonly node: string;
		readonly entry: string;
		readonly packageDir?: string;
	}[];
	readonly reported: readonly string[];
	readonly piVersion: string;
	/** The request each launch environment was derived for, in that run. */
	readonly derived: readonly string[];
	readonly env?: Readonly<Record<string, unknown>>;
	/** What the conversation's screen was handed to show as it started. */
	readonly diagnostics?: readonly { type: string; message: string }[];
}

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) {
		for (const pid of leftRunning(folder).filter(alive)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// It ended between the look and the kill.
			}
		}
		rmSync(folder, { recursive: true, force: true });
	}
});

/** The pids a step's crashing tool left running, as it wrote them down. */
function leftRunning(folder: string): number[] {
	const file = join(folder, "children");
	return existsSync(file)
		? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number)
		: [];
}

/** Whether a process still runs, a zombie counting as ended. */
function alive(pid: number): boolean {
	try {
		return !/^\S+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		// No such process.
		return false;
	}
}

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

/** What a plain pi on the same folder, settings and environment does with `words`. */
async function plainPi(
	folder: string,
	words: string,
): Promise<{ type: string; message: string }[]> {
	if (!packageDir) throw new Error("PI_HOST_PACKAGE_DIR names no package");
	const { stderr } = await run(
		process.execPath,
		[join(packageDir, "dist", "bundle", "cli.js"), "-p", words],
		{ cwd: join(folder, "work"), env: sealedEnv(folder) },
	).catch((error: { stderr?: string }) => {
		// pi's print mode exits 1 when an extension fails to load, after saying which.
		return { stderr: error.stderr ?? String(error) };
	});
	return [...stderr.matchAll(/^(Error|Warning): (.*)$/gm)].map(
		([, prefix, message]) => ({
			type: prefix === "Error" ? "error" : "warning",
			message: message ?? "",
		}),
	);
}

/** Each tool list the probe noted, in the order it noted them. */
function toolLists(folder: string): unknown[] {
	return readFileSync(join(folder, "tools.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
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
			expect(seen.derived, "the launch is derived once, at open").toEqual([
				"open",
			]);
			expect(seen.env).toEqual({
				openedAs: "open",
				marker: seen.sessionId,
				settings: expect.objectContaining({
					harness: "pi",
					harness_version: seen.piVersion,
					surface: "background",
					launch_mode: "fresh",
					model_source: "cli",
					reasoning_source: "default",
				}),
			});
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
		"has the host's own pi pinned for subagents before any extension loads",
		async () => {
			const seen = await step(hostFolder(), "open");
			const root = realpathSync(packageDir ?? "");
			expect(seen.installs).toEqual([
				{
					node: realpathSync(process.execPath),
					entry: join(root, piBin(root)),
					packageDir: root,
				},
			]);
			const [install] = seen.installs;
			const said = await run(
				install?.node ?? "",
				[install?.entry ?? "", "--version"],
				{
					env: {
						PATH: process.env.PATH ?? "",
						HOME: join(hostFolder(), "home"),
						PI_PACKAGE_DIR: root,
					},
				},
			);
			expect(
				`${said.stdout}${said.stderr}`.trim(),
				"the pinned pi runs, and is the pi the host loaded",
			).toContain(seen.piVersion);
		},
		HOST_LIFE_MS,
	);

	it(
		"gives a hosted conversation every tool a plain pi on the same settings has",
		async () => {
			const folder = hostFolder();
			const seen = await step(folder, "tools");
			const plainSaid = await plainPi(folder, "/tools-probe");
			const hostedSaid = (seen.diagnostics ?? []).filter(
				({ type }) => type !== "info",
			);
			expect(hostedSaid, "what the hosted screen shows as it starts").toEqual(
				plainSaid,
			);
			expect(plainSaid, "what plain pi says as it starts").toEqual([]);
			expect(seen.diagnostics, "the screen is handed a list").toBeDefined();
			const [hosted, plain, ...more] = toolLists(folder);
			expect(more).toEqual([]);
			expect(hosted).toEqual(plain);
			expect(hosted).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "tool_search", declared: true }),
					expect.objectContaining({ name: "codemode" }),
					expect.objectContaining({ name: "spend", exposure: "deferred" }),
					expect.objectContaining({ name: "subagent", declared: true }),
					expect.objectContaining({ name: "review_see", declared: true }),
				]),
			);
		},
		// A hosted step and a plain pi, one after the other, each loading the
		// whole harness.
		HOST_LIFE_MS * 2,
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
			expect(resumed.derived, "a resume replays the held launch").toEqual([]);
			expect(resumed.env).toEqual({
				openedAs: "open",
				marker: resumed.sessionId,
				settings: expect.objectContaining({
					harness_version: resumed.piVersion,
					launch_mode: "restore",
				}),
			});
		},
		HOST_LIFE_MS,
	);

	it(
		"carries on a conversation whose host was killed mid-tool, running the tool once",
		async () => {
			const folder = hostFolder();
			expect(await killedStep(folder, "crash")).toBe("SIGKILL");
			const left = leftRunning(folder);
			expect(
				left.filter(alive),
				"both commands outlive the killed host",
			).toHaveLength(2);
			const resumed = await step(folder, "resume");
			expect(resumed.ran).toBe(1);
			expect(
				resumed.childrenAlive,
				"the next start ends what the cut-off tool left, in its group or out",
			).toEqual([]);
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
