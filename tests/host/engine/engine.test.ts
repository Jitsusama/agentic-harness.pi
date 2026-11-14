/**
 * The engine as the host runs it: each step of a host's life is a node
 * process of its own, sealed from this session's environment, driving
 * createEngine through SessionHost with pi's own runtime, a scripted
 * provider and a probe extension. A folder outlives a step, so the next
 * step plays the host's next start. Runs on a pi built with the host's
 * patches, found as tests/host/end-to-end/support/host-pi.ts finds it;
 * without one each case is skipped saying how to get one, and fails
 * under `pnpm test:host`. tests/host/engine/README.md says more.
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Started } from "../../support/spawns.ts";
import { hostPiFor } from "../end-to-end/support/host-pi.ts";

const run = promisify(execFile);
/** The host's pi, found again for each case, which skips or fails without one. */
let packageDir = "";
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
	/** Whether a start left the conversation parked, as one that parked before it. */
	readonly rests?: boolean;
	/** What the conversation's screen was handed to show as it started. */
	readonly diagnostics?: readonly { type: string; message: string }[];
	/**
	 * The background work the engine counted, before and after an extension
	 * handed some off, in all and in that conversation, and in one it never held.
	 */
	readonly background?: {
		readonly before: number;
		readonly during: number;
		readonly own: number;
		readonly unheld: number;
	};
	/** Which conversation each probe load and event ran as, beside the one pi named. */
	readonly as: readonly {
		readonly at: string;
		readonly reason?: string;
		readonly id?: string;
		readonly ambient: string | null;
	}[];
	/** What the engine told the service of conversations becoming others. */
	readonly became: readonly {
		readonly previousId: string;
		readonly sessionId: string;
		readonly held: string;
	}[];
	/** What the engine told the service of conversations ending themselves. */
	readonly ended: readonly {
		readonly sessionId: string;
		readonly why: string;
	}[];
	readonly firstId?: string;
	readonly firstViewed?: boolean;
	readonly held?: readonly string[];
	readonly bothIds?: readonly string[];
	readonly header?: Readonly<Record<string, unknown>>;
	readonly refused?: string;
	/** The warms a parked conversation's host kept for its next start. */
	readonly pending?: number;
	/** The folder each opened conversation was given, opened through a symlink to the work folder. */
	readonly openedIn: readonly string[];
	/** The work folder's own path, past any symlink. */
	readonly work: string;
	/** Each load of the extension the engine was given as pi's `-e` gives one. */
	readonly flagged: readonly unknown[];
	/** The process's listeners for each event, once pi loaded and once the step was done. */
	/** Whether an open on a waiting command answered while it still waited. */
	readonly answeredWhileWaiting?: boolean;
	/** Whether an attended open answered while its screen asked whether to trust its folder. */
	readonly answeredWhileAsking?: boolean;
	/** The trust question its screen was asked, and whether it named that conversation and folder. */
	readonly question?: {
		readonly asked: boolean;
		readonly cwd: boolean;
		readonly title: string;
		readonly labels: readonly string[];
	};
	/** The project folder of each trust question asked, in order. */
	readonly questionsFor?: readonly string[];
	readonly closingScreenClosed?: boolean;
	readonly closingHeld?: string;
	/** What the conversation with nobody to ask was told as it started. */
	readonly nobodySaid?: readonly { type: string; message: string }[];
	readonly built?: readonly boolean[];
	/** What a conversation's screen was told failed after its start answered, and whether it was the one meant to. */
	readonly screenFailures?: readonly { lost: boolean; message: string }[];
	/** Each load of a project folder's own extension. */
	readonly projectLoads?: readonly { loaded: string }[];
	/** Which copy of a linked extension each load ran, once its link moved. */
	readonly linked?: readonly { copy: string }[];
	/** What the first conversation's extensions failed with once it reloaded. */
	readonly afterReload?: readonly string[];
	/** The children a turn started with a call that holds the loop, and where from. */
	readonly blocking?: readonly Started[];
	/** Every child a turn started, and how. */
	readonly started?: readonly string[];
	readonly listeners: {
		readonly atStart: Readonly<Record<string, number>>;
		readonly atEnd: Readonly<Record<string, number>>;
	};
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
	const running = run(
		process.execPath,
		[join(packageDir, "dist", "bundle", "cli.js"), "-p", words],
		{ cwd: join(folder, "work"), env: sealedEnv(folder) },
	);
	// pi reads piped stdin into its prompt, waiting for its end, so it gets
	// an empty one at once.
	running.child.stdin?.end();
	const { stderr } = await running.catch((error: { stderr?: string }) => {
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

describe("the host's engine", () => {
	beforeEach(({ skip }) => {
		packageDir = hostPiFor(skip);
	});

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
			expect(seen.ended, "a closed conversation is said to have ended").toEqual(
				[{ sessionId: seen.sessionId, why: "closed" }],
			);
			expect(
				seen.openedIn,
				"pi works in the folder's own path, as process.cwd() would name it",
			).toEqual([seen.work]);
			expect(
				seen.flagged,
				"an extension the engine is given loads as pi's -e loads it",
			).toEqual([{ loaded: true }]);
			expect(
				seen.listeners.atEnd,
				"a conversation opened and closed leaves the process's listeners as pi left them",
			).toEqual(seen.listeners.atStart);
			expect(seen.reported).toEqual([]);
		},
		HOST_LIFE_MS,
	);

	it(
		"becomes a new conversation from an extension's command, held before pi builds it, and resumes it after a restart",
		async () => {
			const folder = hostFolder();
			const seen = await step(folder, "replace");
			const first = seen.firstId ?? "";
			const next = seen.sessionId ?? "";
			expect(next).not.toBe(first);
			expect(
				seen.became,
				"the service holds it first, before the host registers it",
			).toEqual([{ previousId: first, sessionId: next, held: "not yet" }]);
			expect(
				seen.ended,
				"the conversation it was ends as replaced; a host stopping ends nothing",
			).toEqual([{ sessionId: first, why: "replaced" }]);
			expect(
				seen.firstViewed,
				"the conversation it was has no view left once replaced",
			).toBe(false);
			expect(seen.held).toEqual([next]);
			expect(seen.transcript).toEqual([
				"system: ",
				"user: and you",
				"assistant: fine, thanks",
			]);
			expect(seen.header).toEqual(
				expect.objectContaining({ type: "session", id: next }),
			);
			expect(
				seen.derived,
				"the launch carries over, never derived again",
			).toEqual(["open"]);
			expect(seen.env).toEqual({
				openedAs: "open",
				marker: next,
				settings: expect.objectContaining({ launch_mode: "fresh" }),
			});
			expect(
				seen.as,
				"each load and event runs as the conversation it belongs to",
			).toEqual([
				{ at: "load", ambient: first },
				{ at: "session_start", reason: "startup", id: first, ambient: first },
				{ at: "session_shutdown", reason: "new", id: first, ambient: first },
				{ at: "load", ambient: next },
				{ at: "session_start", reason: "new", id: next, ambient: next },
				{ at: "session_shutdown", reason: "quit", id: next, ambient: next },
			]);
			expect(seen.reported).toEqual([]);
			const resumed = await step(folder, "resume");
			expect(resumed.sessionId).toBe(next);
			expect(
				resumed.sameId,
				"a restart resumes pi's session under the new id",
			).toBe(true);
			expect(resumed.transcript).toEqual([
				"system: ",
				"user: and you",
				"assistant: fine, thanks",
				"user: are you there",
				"assistant: after the restart",
			]);
			expect(resumed.env).toEqual({
				openedAs: "open",
				marker: next,
				settings: expect.objectContaining({ launch_mode: "restore" }),
			});
		},
		HOST_LIFE_MS,
	);

	it(
		"refuses to resume a file another conversation holds, before tearing anything down",
		async () => {
			const seen = await step(hostFolder(), "replace-held");
			expect(seen.refused).toMatch(/open in the host already/);
			expect(seen.held).toEqual(seen.bothIds);
			expect(seen.became).toEqual([]);
			expect(
				seen.probe.filter((line) => line.reason === "resume"),
				"pi never began the switch",
			).toEqual([]);
			expect(seen.transcript).toEqual([
				"system: ",
				"user: hi",
				"assistant: hello there",
				"user: still there",
				"assistant: still here",
			]);
			expect(seen.reported).toEqual([]);
		},
		HOST_LIFE_MS,
	);

	it(
		"has the host's own pi pinned for subagents before any extension loads",
		async () => {
			const seen = await step(hostFolder(), "open");
			const root = realpathSync(packageDir);
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
		"counts the background work a conversation's job host holds, which a restart would end",
		async () => {
			const seen = await step(hostFolder(), "background");
			expect(seen.probe).toContainEqual({ event: "job", started: "true" });
			expect(seen.background).toEqual({
				before: 0,
				during: 1,
				own: 1,
				unheld: 0,
			});
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
					expect.objectContaining({ name: "subagent", exposure: "deferred" }),
					expect.objectContaining({ name: "review_see", declared: true }),
				]),
			);
		},
		// A hosted step and a plain pi, one after the other, each loading the
		// whole harness.
		HOST_LIFE_MS * 2,
	);

	// A host runs every conversation on one loop, so a child one of them
	// starts with spawnSync, execFileSync or execSync holds them all until
	// it exits: 903 ms of one turn in a soak of twelve (13 November). This
	// covers one turn on this package from its prompt to idle, a bash call
	// included, and whatever timers fire meanwhile; not a conversation's
	// start, nor tools the turn doesn't call.
	it(
		"starts no child that holds the loop in a turn on this package",
		async () => {
			const seen = await step(hostFolder(), "turn-children");
			expect(seen.ran, "the turn's bash call ran").toBe(1);
			expect(seen.transcript?.at(-1)).toBe("assistant: done");
			expect(seen.started, "the watch saw the bash call start").not.toEqual([]);
			expect(seen.blocking, "children that held the loop").toEqual([]);
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
		"warms a parked conversation's cache on its own key, once the host has let it go",
		async () => {
			const seen = await step(hostFolder(), "warm-parked");
			expect(
				seen.reported.filter((line) => line.includes("Parked warm")),
				"no parked warm failed",
			).toEqual([]);
			expect(seen.keysSeen, "its turn, then its warm").toEqual([
				"first-key",
				"first-key",
			]);
			expect(seen.pending, "the warm waits for its next start").toBe(1);
		},
		HOST_LIFE_MS,
	);

	it(
		"keeps warming a conversation that rests parked through the host's restart",
		async () => {
			const folder = hostFolder();
			const parked = await step(folder, "park-to-restart");
			expect(parked.held, "the park let it go").toBe("let go");
			const seen = await step(folder, "warm-resting");
			expect(seen.rests, "its next start leaves it parked").toBe(true);
			expect(
				seen.reported.filter((line) => line.includes("Parked warm")),
				"no parked warm failed",
			).toEqual([]);
			expect(seen.keysSeen, "only its warm, on its own key").toEqual([
				"first-key",
			]);
			expect(seen.pending, "the warm waits for its wake").toBe(1);
		},
		2 * HOST_LIFE_MS,
	);

	it(
		"answers an open whose first words are a command still waiting on a person",
		async () => {
			const seen = await step(hostFolder(), "open-waiting");
			expect(
				seen.answeredWhileWaiting,
				"the open answers before the command's wait ends",
			).toBe(true);
			expect(seen.probe).toContainEqual({ event: "wait-started" });
		},
		HOST_LIFE_MS,
	);

	it(
		"trusts each folder as pi decides, asking an attended conversation's screen",
		async () => {
			const seen = await step(hostFolder(), "trust");
			expect(
				seen.projectLoads,
				"only the folders pi's store trusts or the person trusted load their own extension",
			).toEqual([{ loaded: "stored" }, { loaded: "asked" }]);
			expect(seen.questionsFor, "only attended opens are asked").toEqual([
				"asked",
				"closing",
			]);
			expect(seen.question).toMatchObject({ asked: true, cwd: true });
			expect(seen.question?.title).toMatch(/^Trust project folder\?\n/);
			expect(seen.question?.labels).toContain("Trust (this session only)");
			expect(
				seen.answeredWhileAsking,
				"the open answers before the person does",
			).toBe(true);
			expect(seen.built).toEqual([true, true, true]);
			expect(seen.nobodySaid).toEqual([
				{
					type: "warning",
					message: expect.stringMatching(/nobody\/? is not trusted/),
				},
			]);
			expect(
				seen.closingScreenClosed,
				"a close while asking tells the screen",
			).toBe(true);
			expect(seen.closingHeld).toBe("gone");
			expect(
				seen.reported,
				"a warning is one line, an error thrown keeps its kind",
			).toEqual([
				expect.stringMatching(/^Conversation [\w-]+: .*nobody is not trusted/),
				expect.stringMatching(/^Error: .*closed before it was built$/),
			]);
		},
		HOST_LIFE_MS,
	);

	it(
		"answers an open its screen says is asking the person, and shows what fails after",
		async () => {
			const seen = await step(hostFolder(), "open-asking");
			expect(
				seen.answeredWhileAsking,
				"the open answers before the input handler's question is",
			).toBe(true);
			expect(seen.transcript).toEqual([
				"system: ",
				"user: ask me first",
				"assistant: went on",
			]);
			expect(seen.probe).toContainEqual({
				event: "input-asked",
				answer: "Yes",
			});
			expect(seen.screenFailures).toEqual([
				{ lost: true, message: expect.stringMatching(/^No model selected/) },
			]);
			expect(seen.reported).toEqual([
				expect.stringMatching(/No model selected/),
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
			expect(quiet.ended, "a host stopping ends nothing").toEqual([]);
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
		"loads a linked extension through where its link now points, once the copy it first loaded is gone",
		async () => {
			const seen = await step(hostFolder(), "extension-moved");
			expect(
				seen.afterReload,
				"a reload loads the moved extension's helper beside its entry",
			).toEqual([]);
			expect(
				seen.reported,
				"the next conversation's build loads every extension",
			).toEqual([]);
			expect(
				seen.linked,
				"the first build ran the first copy, the reload and the next build the second",
			).toEqual([{ copy: "first" }, { copy: "second" }, { copy: "second" }]);
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

	it(
		"ends at its start what a killed host's tools left, for a conversation it does not resume",
		async () => {
			const folder = hostFolder();
			expect(await killedStep(folder, "crash")).toBe("SIGKILL");
			expect(
				leftRunning(folder).filter(alive),
				"both commands outlive the killed host",
			).toHaveLength(2);
			const started = await step(folder, "start");
			expect(
				started.childrenAlive,
				"the next start ends them before it resumes anything",
			).toEqual([]);
			expect(started.reported, "said as one line, not an error").toEqual([
				expect.stringMatching(
					/^Ended what an earlier host's tools left running/,
				),
			]);
		},
		HOST_LIFE_MS,
	);
});
