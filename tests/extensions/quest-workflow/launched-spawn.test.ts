import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	decideSpawn,
	decideStart,
	handToHost,
	launchedStart,
	type LaunchedSpawn,
	launchedSpawn,
	SPAWN_HOSTED,
	SPAWN_STAYS,
	STAYED_VARIABLE,
	settleLaunchedSpawn,
} from "../../../extensions/quest-workflow/launched-spawn.ts";
import {
	type ControlCall,
	OPEN_PATIENCE_MS,
} from "../../../extensions/quest-workflow/verbs/spawn-host.ts";
import type { ControlRequest } from "../../../host/service/protocol.ts";
import { leaveFirstWords } from "../../../lib/internal/quest/first-words.ts";

const QUEST = "QEST-20261112-ABCDEF";
const WORDS = "Carry on with QEST-20261112-ABCDEF.";

let root: string;
let runtime: string;
let dir: string;
let sessionId: string;
let sent: ControlRequest[];
let patience: Map<string, number | undefined>;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "launched-spawn-"));
	// Short, since a host's socket path has to fit a Unix socket's limit.
	runtime = mkdtempSync(join(tmpdir(), "k7-"));
	dir = join(root, "first-words");
	sessionId = randomUUID();
	sent = [];
	patience = new Map();
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(runtime, { recursive: true, force: true });
});

/** The environment a launcher-started pi runs in, in the work realm. */
function envOf(extra: Record<string, string> = {}) {
	return {
		QUEST_WORKFLOW_AUTOLOAD_ID: QUEST,
		MYCELIUM_REALM: "work",
		PI_HOME_REALM: "work",
		XDG_RUNTIME_DIR: runtime,
		...extra,
	};
}

/** The pi's words as the launcher starts a fresh spawn. */
function argvOf(...more: string[]) {
	return ["node", "pi", "--session-id", sessionId, ...more];
}

/** A host that lists, and opens as `open` says. */
function hostThat(
	open: (request: ControlRequest) => Awaited<ReturnType<ControlCall>>,
): ControlCall {
	return async (_socket, request, timeoutMs) => {
		sent.push(request);
		patience.set(request.op, timeoutMs);
		if (request.op === "list") {
			return { v: 1, id: request.id, ok: true, result: { sessions: [] } };
		}
		return open(request);
	};
}

/** A host that opens what it is asked under `opened`. */
function opening(opened: string): ControlCall {
	return hostThat((request) => ({
		v: 1,
		id: request.id,
		ok: true,
		result: {
			sessionId: opened,
			file: join(root, "logs", `${opened}.jsonl`),
			cwd: request.op === "open" ? request.cwd : root,
			state: "busy",
			since: new Date().toISOString(),
		},
	}));
}

/** No host listening: the connection is refused before anything is sent. */
const nobody: ControlCall = async () => {
	throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
};

/** What is left of the spawn's words: waiting, taken, or both. */
function leftOf(): string[] {
	return [".json", ".taken"].filter((end) =>
		existsSync(join(dir, `${sessionId}${end}`)),
	);
}

function spawned(): LaunchedSpawn {
	const spawn = launchedSpawn(argvOf(), envOf(), root, dir);
	if (!spawn) throw new Error("the launched spawn wasn't recognised");
	return spawn;
}

function factsOf(setting: string | undefined, call: ControlCall, agent = "pi") {
	return {
		setting: async () =>
			setting === undefined
				? {}
				: { setting: setting as "off" | "attended" | "background" },
		agent: async () => agent,
		env: envOf({ PI_SANDBOX: "fenced" }),
		call,
		dir,
	};
}

describe("a pi the launcher started for a spawn", () => {
	it("is one started under its own id with its spawn's words waiting", () => {
		leaveFirstWords(sessionId, WORDS, dir);

		expect(
			launchedSpawn(
				argvOf("--model", "proxy/claude-opus:high"),
				envOf(),
				root,
				dir,
			),
		).toEqual({
			sessionId,
			questId: QUEST,
			cwd: root,
			model: { provider: "proxy", id: "claude-opus" },
			thinkingLevel: "high",
		});
	});

	it("is no other pi", () => {
		leaveFirstWords(sessionId, WORDS, dir);

		expect(launchedSpawn(["node", "pi"], envOf(), root, dir)).toBeUndefined();
		expect(launchedSpawn(argvOf(), {}, root, dir)).toBeUndefined();
		expect(
			launchedSpawn(argvOf(), envOf(), root, join(root, "elsewhere")),
		).toBeUndefined();
	});
});

describe("handing a launched spawn to its host", () => {
	it("sends it to the host spawnHost names, words, folder, quest and model alike, and records the host's session as taking them", async () => {
		leaveFirstWords(sessionId, WORDS, dir);
		const spawn = launchedSpawn(
			argvOf("--model", "proxy/claude-opus"),
			envOf(),
			root,
			dir,
		);
		if (!spawn) throw new Error("the launched spawn wasn't recognised");
		const hosted = randomUUID();

		const handed = await handToHost(
			spawn,
			factsOf("attended", opening(hosted)),
		);

		expect(handed).toEqual({
			hosted: true,
			host: "work-attended",
			kind: "attended",
			sessionId: hosted,
		});
		expect(sent.find((one) => one.op === "open")).toMatchObject({
			op: "open",
			cwd: root,
			attended: true,
			quest: QUEST,
			first: WORDS,
			model: { provider: "proxy", id: "claude-opus" },
			env: { PI_SANDBOX: "fenced" },
		});
		expect(leftOf(), "the words are taken, not waiting").toEqual([".taken"]);
		expect(
			JSON.parse(readFileSync(join(dir, `${sessionId}.taken`), "utf8")),
		).toMatchObject({ sessionId: hosted, said: true });
	});

	it("stays in its window, saying nothing, while spawnHost is off or unset", async () => {
		leaveFirstWords(sessionId, WORDS, dir);

		expect(await handToHost(spawned(), factsOf("off", opening("x")))).toEqual({
			hosted: false,
		});
		expect(
			await handToHost(spawned(), factsOf(undefined, opening("x"))),
		).toEqual({ hosted: false });
		expect(sent).toEqual([]);
		expect(leftOf(), "the words still wait").toEqual([".json"]);
	});

	it("stays, saying why, in a realm whose agent no host runs", async () => {
		leaveFirstWords(sessionId, WORDS, dir);

		const handed = await handToHost(
			spawned(),
			factsOf("background", opening("x"), "pi-claude"),
		);

		expect(handed).toEqual({
			hosted: false,
			note: expect.stringContaining("starts pi-claude"),
		});
		expect(sent).toEqual([]);
		expect(leftOf(), "the words still wait").toEqual([".json"]);
	});

	it("stays, saying why, when no host is listening", async () => {
		leaveFirstWords(sessionId, WORDS, dir);

		const handed = await handToHost(spawned(), factsOf("background", nobody));

		expect(handed).toEqual({
			hosted: false,
			note: expect.stringContaining("no work-background host is listening"),
		});
		expect(leftOf(), "the words still wait").toEqual([".json"]);
	});

	it("stays with its words put back when the host turns it away", async () => {
		leaveFirstWords(sessionId, WORDS, dir);
		const refusing = hostThat((request) => ({
			v: 1,
			id: request.id,
			ok: false,
			error: { code: "busy", message: "too many conversations" },
		}));

		const handed = await handToHost(spawned(), factsOf("background", refusing));

		expect(handed).toEqual({
			hosted: false,
			note: expect.stringContaining("too many conversations"),
		});
		expect(leftOf(), "the words are put back, untaken").toEqual([".json"]);
	});
});

describe("deciding a launched spawn headless, for the launcher", () => {
	/** Decide, answering the exit status and the lines said. */
	async function decided(setting: string | undefined, call: ControlCall) {
		const lines: string[] = [];
		const code = await decideSpawn(
			argvOf(),
			root,
			factsOf(setting, call),
			(line) => lines.push(line),
			join(root, "state"),
		);
		return { code, lines };
	}

	function logged(): string {
		const log = join(root, "state", "launched-spawns.log");
		return existsSync(log) ? readFileSync(log, "utf8") : "";
	}

	it("says it is opening, then where it went, and answers hosted", async () => {
		leaveFirstWords(sessionId, WORDS, dir);
		const hosted = randomUUID();

		expect(await decided("attended", opening(hosted))).toEqual({
			code: SPAWN_HOSTED,
			lines: ["opening work-attended", `hosted work-attended ${hosted}`],
		});
		expect(leftOf(), "the words are taken by the host").toEqual([".taken"]);
		expect(
			patience.get("open"),
			"the open waits as long as a host takes to load a conversation",
		).toBe(OPEN_PATIENCE_MS);
		expect(logged()).toMatch(
			new RegExp(
				`spawn ${sessionId} for ${QUEST} went to the work-attended host as session ${hosted} \\(headless, \\d+ ms\\)`,
			),
		);
	});

	it("answers stays, saying nothing, while spawnHost is off", async () => {
		leaveFirstWords(sessionId, WORDS, dir);

		expect(await decided("off", opening("x"))).toEqual({
			code: SPAWN_STAYS,
			lines: [],
		});
		expect(sent).toEqual([]);
		expect(leftOf(), "the words still wait").toEqual([".json"]);
	});

	it("answers stays, saying nothing and asking no host, for what isn't a spawn", async () => {
		expect(await decided("attended", opening("x"))).toEqual({
			code: SPAWN_STAYS,
			lines: [],
		});
		expect(sent).toEqual([]);
		expect(logged()).toBe("");
	});

	it("answers stays with why, before opening anything, when no host is listening", async () => {
		leaveFirstWords(sessionId, WORDS, dir);

		const { code, lines } = await decided("background", nobody);

		expect(code).toBe(SPAWN_STAYS);
		expect(lines).toEqual([
			expect.stringContaining("no work-background host is listening"),
		]);
		expect(leftOf(), "the words still wait").toEqual([".json"]);
	});

	it("answers stays with why, words put back, when the host turns the open away", async () => {
		leaveFirstWords(sessionId, WORDS, dir);
		const refusing = hostThat((request) => ({
			v: 1,
			id: request.id,
			ok: false,
			error: { code: "busy", message: "too many conversations" },
		}));

		const { code, lines } = await decided("background", refusing);

		expect(code).toBe(SPAWN_STAYS);
		expect(lines).toEqual([
			"opening work-background",
			expect.stringContaining("too many conversations"),
		]);
		expect(leftOf(), "the words are put back, untaken").toEqual([".json"]);
		expect(logged()).toContain("stayed in its window");
	});
});

describe("deciding the launcher's own start headless", () => {
	/** Decide `argv`'s start, answering the exit status and the lines said. */
	async function started(
		setting: string | undefined,
		call: ControlCall,
		...argv: string[]
	) {
		const start = launchedStart(["--start", ...argv], envOf(), root);
		if (!start) throw new Error("the launcher's start wasn't recognised");
		const lines: string[] = [];
		const code = await decideStart(
			start,
			{
				setting: async () =>
					setting === undefined
						? {}
						: { setting: setting as "off" | "attended" },
				agent: async () => "pi",
				env: envOf({ PI_SANDBOX: "fenced" }),
				call,
			},
			(line) => lines.push(line),
			join(root, "state"),
		);
		return { code, lines };
	}

	it("is a start only when the launcher says so, on a quest", () => {
		expect(
			launchedStart(
				["--start", "--orchestrate", "--model", "proxy/claude-opus:high"],
				envOf(),
				root,
			),
		).toEqual({
			questId: QUEST,
			cwd: root,
			orchestrate: true,
			model: { provider: "proxy", id: "claude-opus" },
			thinkingLevel: "high",
		});
		expect(launchedStart(["--start"], envOf(), root)).toEqual({
			questId: QUEST,
			cwd: root,
			orchestrate: false,
		});
		expect(launchedStart([], envOf(), root)).toBeUndefined();
		expect(launchedStart(["--start"], {}, root)).toBeUndefined();
	});

	it("opens it in the attended host told nothing, says where, and answers hosted", async () => {
		const hosted = randomUUID();

		expect(await started("attended", opening(hosted))).toEqual({
			code: SPAWN_HOSTED,
			lines: ["opening work-attended", `hosted work-attended ${hosted}`],
		});
		const open = sent.find((one) => one.op === "open");
		expect(open).toMatchObject({
			op: "open",
			cwd: root,
			attended: true,
			quest: QUEST,
			env: { PI_SANDBOX: "fenced" },
		});
		expect(open, "Joel types its first words himself").not.toHaveProperty(
			"first",
		);
		expect(open).not.toHaveProperty("orchestrate");
		expect(patience.get("open")).toBe(OPEN_PATIENCE_MS);
	});

	it("opens an Orchestrate orchestrating, on the model it names", async () => {
		await started(
			"attended",
			opening(randomUUID()),
			"--orchestrate",
			"--model",
			"proxy/claude-opus",
		);

		expect(sent.find((one) => one.op === "open")).toMatchObject({
			quest: QUEST,
			orchestrate: true,
			model: { provider: "proxy", id: "claude-opus" },
		});
	});

	it("answers stays, saying nothing and asking no host, while startHost is off or unset", async () => {
		expect(await started("off", opening("x"))).toEqual({
			code: SPAWN_STAYS,
			lines: [],
		});
		expect(await started(undefined, opening("x"))).toEqual({
			code: SPAWN_STAYS,
			lines: [],
		});
		expect(sent).toEqual([]);
	});

	it("answers stays with why, naming startHost, when no host is listening", async () => {
		const { code, lines } = await started("attended", nobody);

		expect(code).toBe(SPAWN_STAYS);
		expect(lines).toEqual([
			expect.stringMatching(
				/^quest-workflow\.startHost is attended, but no work-attended host is listening/,
			),
		]);
	});

	it("answers stays with why when the host turns the open away", async () => {
		const refusing = hostThat((request) => ({
			v: 1,
			id: request.id,
			ok: false,
			error: { code: "busy", message: "too many conversations" },
		}));

		const { code, lines } = await started("attended", refusing);

		expect(code).toBe(SPAWN_STAYS);
		expect(lines).toEqual([
			"opening work-attended",
			expect.stringContaining("too many conversations"),
		]);
	});
});

describe("settling a launched spawn as pi starts", () => {
	it("decides no more once the launcher's decider kept it in its window, saying why", async () => {
		leaveFirstWords(sessionId, WORDS, dir);
		let ended = 0;
		const end = () => {
			ended += 1;
		};

		const why = await settleLaunchedSpawn(
			argvOf(),
			envOf({ [STAYED_VARIABLE]: "no work-attended host is listening" }),
			end,
			opening("x"),
		);
		const quiet = await settleLaunchedSpawn(
			argvOf(),
			envOf({ [STAYED_VARIABLE]: "" }),
			end,
			opening("x"),
		);

		expect(why).toBe("no work-attended host is listening");
		expect(quiet).toBeUndefined();
		expect(ended, "the pi carries on in its window").toBe(0);
		expect(sent, "no host is asked again").toEqual([]);
	});

	it("leaves any other pi be, ending nothing", async () => {
		let ended = 0;

		const note = await settleLaunchedSpawn(
			["node", "pi"],
			envOf(),
			() => {
				ended += 1;
			},
			opening("x"),
		);

		expect(note).toBeUndefined();
		expect(ended).toBe(0);
		expect(sent).toEqual([]);
	});
});
