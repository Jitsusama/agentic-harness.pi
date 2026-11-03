import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQuestState } from "../../../extensions/quest-workflow/state";
import { handle } from "../../../extensions/quest-workflow/transitions";
import {
	FIRST_WORDS_VARIABLE,
	firstWordsDir,
} from "../../../lib/internal/quest/first-words";
import {
	clearTerminalDrivers,
	registerTerminalDriver,
} from "../../../lib/terminal/index";
import { createEnvGuard } from "./_helpers";

// The launcher is asked through `qs` on PATH, so a stand-in `qs` writes
// down what it was asked and answers what the test tells it to. Asked
// whether the lock is up, it says what QS_LOCKED says, else no.
const FAKE_QS = `#!/bin/sh
if [ "$3" = lock ]; then printf '%s\\n' "\${QS_LOCKED:-false}"; exit 0; fi
printf '%s\\n' "$@" > "$QS_ASKED"
printf '%s\\n' "$QS_SAYS"
`;

const kept: Record<string, string | undefined> = {};
const KEPT = [
	"HOME",
	"PATH",
	"PI_LAUNCHER",
	"XDG_CONFIG_HOME",
	"QS_ASKED",
	"QS_SAYS",
	"QS_LOCKED",
];
let tmpRoot: string;
let opened: string | undefined;
let openedEnv: Record<string, string> | undefined;

/** The words a spawn left for the session under `key`, if any. */
function wordsFor(key: string): string | undefined {
	const path = join(firstWordsDir(), `${key}.json`);
	if (!existsSync(path)) return undefined;
	return (JSON.parse(readFileSync(path, "utf8")) as { words: string }).words;
}
const envGuard = createEnvGuard();

function fakePi() {
	return { setSessionName: () => {} } as unknown as Parameters<
		typeof handle
	>[1];
}
function fakeCtx(cwd: string, sessionId: string) {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId, isPersisted: () => true },
	} as unknown as Parameters<typeof handle>[2];
}

/** What the launcher was handed, or undefined when it wasn't asked. */
function handed(): unknown {
	const asked = process.env.QS_ASKED as string;
	if (!existsSync(asked)) return undefined;
	const words = readFileSync(asked, "utf8").trim().split("\n");
	expect(words.slice(0, 4)).toEqual(["ipc", "call", "sessions", "reopen"]);
	return JSON.parse(words[4] as string);
}

async function quest() {
	const state = createQuestState({ questsRoot: join(tmpRoot, "quests") });
	const created = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
		action: "create",
		title: "Alpha",
	});
	if (!created.ok) throw new Error(created.guidance);
	return { state, id: state.questId as string };
}

beforeEach(() => {
	envGuard.enter();
	for (const name of KEPT) kept[name] = process.env[name];
	tmpRoot = mkdtempSync(join(tmpdir(), "spawn-launcher-"));
	process.env.HOME = tmpRoot;
	const bin = join(tmpRoot, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "qs"), FAKE_QS);
	chmodSync(join(bin, "qs"), 0o755);
	process.env.PATH = `${bin}:${process.env.PATH}`;
	process.env.QS_ASKED = join(tmpRoot, "asked");
	process.env.QS_SAYS = "taken";
	delete process.env.PI_LAUNCHER;
	// The person's settings open a kitty window, as the launcher does.
	const config = join(tmpRoot, "config");
	mkdirSync(join(config, "pi", "agentic-harness.pi"), { recursive: true });
	writeFileSync(
		join(config, "pi", "agentic-harness.pi", "config.json"),
		JSON.stringify({
			version: 1,
			sections: {
				terminal: { defaults: { driver: "kitty", layout: "window" } },
			},
		}),
	);
	process.env.XDG_CONFIG_HOME = config;
	opened = undefined;
	openedEnv = undefined;
	rmSync(firstWordsDir(), { recursive: true, force: true });
	clearTerminalDrivers();
	registerTerminalDriver({
		id: "kitty",
		available: () => true,
		async spawn(req) {
			opened = req.command;
			openedEnv = req.env;
		},
	});
});
afterEach(() => {
	clearTerminalDrivers();
	for (const name of KEPT) {
		if (kept[name] === undefined) delete process.env[name];
		else process.env[name] = kept[name];
	}
	rmSync(tmpRoot, { recursive: true, force: true });
	envGuard.leave();
});

describe("spawn through the desktop's launcher", () => {
	it("hands a new session to the launcher, fresh on its quest, and opens nothing itself", async () => {
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
		});
		if (!result.ok) throw new Error(result.guidance);
		const given = handed() as {
			sessions: { id: string; cwd: string; fresh: boolean; quest: string }[];
		};
		expect(given.sessions).toHaveLength(1);
		const [session] = given.sessions;
		// Without focus, beside the session that asked, which is "spawner".
		expect(session).toMatchObject({
			cwd: tmpRoot,
			fresh: true,
			quest: id,
			from: "spawner",
			focus: false,
		});
		expect(session?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
		expect(opened).toBeUndefined();
		expect(result.message).toContain(`Handed a new session, ${session?.id}`);
	});

	it("tells the session it hands over to carry on with its quest, and what for", async () => {
		// 7 of 9 builders spawned on 11-03 sat idle until pivoted.
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
			note: "Build the slice weights from 5FWIUS's numbers.",
		});
		if (!result.ok) throw new Error(result.guidance);
		const given = handed() as { sessions: { id: string }[] };
		const words = wordsFor(given.sessions[0]?.id as string);
		expect(words).toMatch(/^\[Automated message, no human input: /);
		expect(words).toContain(`Carry on with ${id}`);
		expect(words).toContain("Build the slice weights from 5FWIUS's numbers.");
	});

	it("names the words in the window's environment when it opens one itself", async () => {
		process.env.QS_SAYS = "refused: no session with an id and a folder";
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
		});
		if (!result.ok) throw new Error(result.guidance);
		const token = openedEnv?.[FIRST_WORDS_VARIABLE] as string;
		expect(wordsFor(token)).toContain(`Carry on with ${id}`);
	});

	it("leaves no words for a command of the caller's own", async () => {
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
			command: "htop",
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(opened).toBe("htop");
		expect(openedEnv?.[FIRST_WORDS_VARIABLE]).toBeUndefined();
		expect(existsSync(firstWordsDir())).toBe(false);
	});

	it("opens the window itself when the launcher refuses", async () => {
		process.env.QS_SAYS = "refused: no session with an id and a folder";
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(handed()).toBeDefined();
		expect(opened).toBe("pi");
		expect(result.message).toContain("Spawned a window");
	});

	it("hands the session to the launcher while the screen is locked", async () => {
		// The shell starts it behind the lock and places it once the lock
		// is gone (core.nix #1632), where a window opened here would sit
		// wherever the terminal put it.
		process.env.QS_LOCKED = "true";
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(handed()).toBeDefined();
		expect(opened).toBeUndefined();
	});

	it("leaves a layout the call names to the terminal", async () => {
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn-tab",
			id,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(handed()).toBeUndefined();
		expect(opened).toBe("pi");
	});

	it("asks nothing on a dry run, saying the launcher goes first", async () => {
		const { state, id } = await quest();
		const result = await handle(state, fakePi(), fakeCtx(tmpRoot, "spawner"), {
			action: "spawn",
			id,
			dryRun: true,
		});
		if (!result.ok) throw new Error(result.guidance);
		expect(handed()).toBeUndefined();
		expect(opened).toBeUndefined();
		expect(result.message).toContain("it goes first to the desktop's launcher");
		expect(existsSync(firstWordsDir())).toBe(false);
	});
});
