/**
 * pi-carry as mycelium runs it: node running the script as it stands, on
 * one machine's home carrying a quest's resting session, then on
 * another's arriving with it, each a home of its own in a temp folder
 * sharing one quest scratch, as mycelium's share would.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createTreeMemory } from "../../lib/core/work/memory.ts";
import { thisMachine } from "../../lib/internal/machine.ts";
import {
	bareOrigin,
	cloneAt,
	commit,
	folder,
	removeAll,
} from "../lib/internal/carry/support/machines.ts";
import { git } from "../support/git-fixture.ts";

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "pi-carry.ts");
const QUEST = "QEST-20261107-CARRY3";
const SESSION = "01a19111-pi-carry";

const made: string[] = [];
afterEach(() => removeAll(made));

/** One machine: a home, its XDG folders, and the quest scratch it shares. */
function machine(name: string, cache: string) {
	const home = folder(made, name);
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: cache,
	};
	return { home, env };
}

/** pi-carry's lines and exit code, run by node under `env`. */
async function piCarry(env: NodeJS.ProcessEnv, ...args: string[]) {
	const finished = await run(
		"node",
		["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT, ...args],
		{ env },
	).then(
		(done) => ({ code: 0, stdout: done.stdout }),
		(failed: { code?: number; stdout?: string }) => ({
			code: failed.code ?? -1,
			stdout: failed.stdout ?? "",
		}),
	);
	return {
		code: finished.code,
		lines: finished.stdout
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line)),
	};
}

/**
 * The leaving machine: a quest session nobody closed and no pi runs,
 * holding a tree with a commit no remote has and a change never made.
 */
async function leaving(cache: string) {
	const origin = await bareOrigin(made);
	const one = machine("leaving", cache);
	const tree = await cloneAt(origin, join(one.home, "src", "app"));
	await git(tree, "checkout", "-q", "-b", "topic");
	const head = await commit(tree, "work.txt", "unpushed\n");
	writeFileSync(join(tree, "README.md"), "changed, never committed\n");
	const state = join(one.home, ".local", "state", "pi", "agentic-harness.pi");
	const registry = join(state, "quest-workflow", "sessions");
	mkdirSync(registry, { recursive: true });
	writeFileSync(
		join(registry, `${SESSION}.json`),
		JSON.stringify({
			sessionId: SESSION,
			instanceId: "i-1",
			cwd: tree,
			quest: QUEST,
			openedAt: "2026-11-07T20:00:00.000Z",
		}),
	);
	createTreeMemory(join(state, "work", "cut")).remember({
		identity: { key: "app", shareable: false },
		path: tree,
		providerId: "git",
		sessions: [SESSION],
	});
	const sessions = join(one.home, ".pi", "agent", "sessions", "--src-app--");
	mkdirSync(sessions, { recursive: true });
	writeFileSync(
		join(sessions, `2026-11-07T20-00-00-000Z_${SESSION}.jsonl`),
		`${JSON.stringify({ type: "session", id: SESSION, cwd: tree })}\n`,
	);
	return { ...one, origin, head };
}

describe("pi-carry", () => {
	it("carries a quest's resting session on one machine, and arrives with it on another", async () => {
		const cache = folder(made, "cache");
		const from = await leaving(cache);
		const to = machine("arriving", cache);
		const handover = join(
			cache,
			"pi",
			"agentic-harness.pi",
			"quest-workspace",
			QUEST,
			"handover",
			thisMachine(),
		);

		const carried = await piCarry(from.env, QUEST, "--to", "elsewhere-machine");

		expect(carried.code).toBe(0);
		expect(carried.lines.at(-1)).toEqual({
			kind: "done",
			files: [join(handover, `${SESSION}.done.json`)],
		});

		const arrived = await piCarry(
			to.env,
			"arrive",
			QUEST,
			"--from",
			thisMachine(),
			"--session",
			SESSION,
		);

		const tree = join(to.home, "src", "app");
		expect(arrived).toEqual({
			code: 0,
			lines: [
				{ kind: "tree", path: tree, branch: "topic", did: "cloned" },
				{ kind: "sessions", sessions: [{ id: SESSION, cwd: tree }] },
			],
		});
		expect(await git(tree, "rev-parse", "HEAD")).toBe(from.head);
		expect(await git(tree, "status", "--porcelain")).toBe("M README.md");
		expect(
			readdirSync(join(to.home, ".pi", "agent", "sessions")),
			"its session is placed where pi --session finds it from its folder",
		).toEqual([`--${tree.slice(1).replaceAll("/", "-")}--`]);

		const elsewhere = machine("refusing", cache);
		await cloneAt(await bareOrigin(made), join(elsewhere.home, "src", "app"));
		const refused = await piCarry(
			elsewhere.env,
			"arrive",
			QUEST,
			"--from",
			thisMachine(),
			"--session",
			SESSION,
		);
		expect(refused.code, "a tree refused starts nothing after it").toBe(1);
		expect(refused.lines[0]).toMatchObject({ kind: "tree", did: "refused" });
	});

	it("exits 2, saying why, when it is asked wrongly", async () => {
		const one = machine("asked", folder(made, "cache"));

		const asked = await piCarry(one.env, "not-a-quest", "--to", "penelope");

		expect(asked.code).toBe(2);
		expect(asked.lines).toEqual([
			{ kind: "failed", why: expect.stringContaining("Say which quest") },
		]);
	});
});
