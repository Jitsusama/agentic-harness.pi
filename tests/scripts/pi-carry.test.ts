/**
 * pi-carry as mycelium runs it: node running the script as it stands, on
 * one machine's home carrying a quest's resting session, then on
 * another's arriving with it, each a home of its own in a temp folder
 * sharing one quest scratch, as mycelium's share would.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createTreeMemory } from "../../lib/core/work/memory.ts";
import { CARRY_HELP } from "../../lib/internal/carry/help.ts";
import { thisMachine } from "../../lib/internal/machine/machine.ts";
import { sessionAddress } from "../../lib/mesh/address.ts";
import { inboxOf, takeSteers } from "../../lib/mesh/steer.ts";
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

/** What pi-carry printed and exited with, run by node under `env`. */
function piCarryRaw(env: NodeJS.ProcessEnv, ...args: string[]) {
	return run(
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
}

/** pi-carry's lines and exit code, run by node under `env`. */
async function piCarry(env: NodeJS.ProcessEnv, ...args: string[]) {
	const finished = await piCarryRaw(env, ...args);
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

/** Every file under `dir`, git's own objects included, whose bytes hold `secret`. */
function filesHolding(dir: string, secret: string): string[] {
	const found: string[] = [];
	const walk = (at: string) => {
		for (const name of readdirSync(at)) {
			const path = join(at, name);
			const stat = statSync(path, { throwIfNoEntry: false });
			if (stat?.isDirectory()) walk(path);
			else if (stat?.isFile() && readFileSync(path).includes(secret)) {
				found.push(path);
			}
		}
	};
	walk(dir);
	return found;
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
		expect(
			await piCarryRaw(
				to.env,
				"where",
				QUEST,
				"--from",
				thisMachine(),
				"--session",
				SESSION,
			),
			"where says the folder it arrived in, alone, for a shell to enter",
		).toEqual({ code: 0, stdout: `${tree}\n` });
		expect(
			await piCarryRaw(
				to.env,
				"where",
				QUEST,
				"--from",
				thisMachine(),
				"--session",
				"01a19111-never-carried",
			),
			"and names no folder for a session nothing carried",
		).toEqual({ code: 1, stdout: "" });
		const fenceOf = (session: string) =>
			piCarryRaw(
				to.env,
				"fence",
				QUEST,
				"--from",
				thisMachine(),
				"--session",
				session,
			);
		expect(
			await fenceOf(SESSION),
			"fence says nothing of a session carried without its fence",
		).toEqual({ code: 0, stdout: "" });
		expect(
			await fenceOf("01a19111-never-carried"),
			"and fails for a session nothing carried",
		).toEqual({ code: 1, stdout: "" });
		const done = join(handover, `${SESSION}.done.json`);
		for (const [kind, asked] of [
			["strict", "strict\n"],
			["none", "off\n"],
		] as const) {
			writeFileSync(
				done,
				JSON.stringify({
					...JSON.parse(readFileSync(done, "utf8")),
					fence: kind,
				}),
			);
			expect(
				await fenceOf(SESSION),
				`fence says what PI_SANDBOX starts a session that ran under ${kind}`,
			).toEqual({ code: 0, stdout: asked });
		}

		const settled = await piCarry(
			from.env,
			"settle",
			QUEST,
			"--session",
			SESSION,
		);
		expect(
			settled,
			"settle leaves a checkout of its own where it is, and says it settled",
		).toEqual({
			code: 0,
			lines: [
				{ kind: "tree", path: "~/src/app", did: "stays" },
				{ kind: "settled", session: SESSION, let: 0 },
			],
		});
		expect(
			(
				await piCarry(
					from.env,
					"settle",
					QUEST,
					"--session",
					"01a19111-never-carried",
				)
			).code,
			"and fails for a session nothing carried",
		).toBe(1);

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

	// ISXEG8's condition 5 (15 November), as KP0L6A placed it: nothing
	// travels but the work, wherever a secret sits on the leaving machine.
	it.each([
		["an orchestrator", "WCJQSG", "the orchestrator above its quest"],
		[
			"the node of the machine it left",
			`node@${thisMachine()}`,
			"no orchestrator ordered it",
		],
	])(
		"carries no secret planted beside the work, and tells the arrival that %s carried it and why",
		async (_whom, by, said) => {
			const cache = folder(made, "cache");
			const from = await leaving(cache);
			const to = machine("arriving", cache);
			const secret = `planted-${randomBytes(12).toString("hex")}`;
			const tree = join(from.home, "src", "app");
			await commit(tree, ".gitignore", ".env\n");
			writeFileSync(join(tree, ".env"), `TOKEN=${secret}\n`);
			mkdirSync(join(from.home, ".config", "gh"), { recursive: true });
			writeFileSync(
				join(from.home, ".config", "gh", "hosts.yml"),
				`oauth_token: ${secret}\n`,
			);
			const scratch = join(
				cache,
				"pi",
				"agentic-harness.pi",
				"quest-workspace",
				QUEST,
			);
			mkdirSync(join(scratch, "tmp"), { recursive: true });
			writeFileSync(join(scratch, "tmp", "token.txt"), secret);
			const planted = (env: NodeJS.ProcessEnv) => ({
				...env,
				GITHUB_TOKEN: secret,
				PI_PLANTED: secret,
			});

			const carried = await piCarry(
				planted(from.env),
				QUEST,
				"--to",
				"elsewhere-machine",
			);
			const arrived = await piCarry(
				planted(to.env),
				"arrive",
				QUEST,
				"--from",
				thisMachine(),
				"--session",
				SESSION,
				"--by",
				by,
				"--why",
				"its camera work needs the Mac",
			);

			expect(carried.code).toBe(0);
			expect(arrived.code).toBe(0);
			const handover = join(scratch, "handover");
			expect(
				filesHolding(handover, secret),
				"no file the handover carries holds it",
			).toEqual([]);
			expect(
				filesHolding(to.home, secret),
				"nor anything arriving placed",
			).toEqual([]);
			const arrivedTree = join(to.home, "src", "app");
			expect(
				readdirSync(arrivedTree),
				"the tree arrived, its ignored file left behind",
			).not.toContain(".env");
			// Git keeps objects compressed, so what the bundle brought is read
			// back through git, every commit's every change.
			expect(
				await git(arrivedTree, "log", "--all", "-p", "--binary"),
				"nor any commit the bundle brought",
			).not.toContain(secret);
			const inbox = inboxOf(
				join(to.home, ".local", "state", "pi", "agentic-harness.pi", "steer"),
				sessionAddress(SESSION),
			);
			const [told] = takeSteers(inbox, "1").steers;
			expect(told).toMatchObject({ from: "machine", by: "pi-carry" });
			expect(told?.text).toContain(
				`carried here from ${thisMachine()} by ${by}, for its camera work needs the Mac`,
			);
			expect(told?.text).toContain(said);
		},
	);

	it("refuses an arrival that names who carried it without why, why without who, or another machine's node", async () => {
		const one = machine("asked", folder(made, "cache"));
		const arrive = ["arrive", QUEST, "--from", "optimus", "--session", SESSION];

		const byAlone = await piCarry(one.env, ...arrive, "--by", "WCJQSG");
		const whyAlone = await piCarry(one.env, ...arrive, "--why", "the Mac");
		const byNoAddress = await piCarry(
			one.env,
			...arrive,
			"--by",
			"../x",
			"--why",
			"the Mac",
		);

		const byAnotherNode = await piCarry(
			one.env,
			...arrive,
			"--by",
			"node@penelope",
			"--why",
			"optimus has stalled",
		);

		const byNodeInOtherLetters = await piCarry(
			one.env,
			...arrive,
			"--by",
			"node@Optimus",
			"--why",
			"optimus has stalled",
		);

		for (const [asked, by] of [
			[byAnotherNode, "node@penelope"],
			[byNodeInOtherLetters, "node@Optimus"],
		] as const) {
			expect(asked.lines).toEqual([
				{
					kind: "failed",
					why: expect.stringContaining(
						`--by ${by} names a node other than node@optimus, as written`,
					),
				},
			]);
		}
		for (const asked of [
			byAlone,
			whyAlone,
			byNoAddress,
			byAnotherNode,
			byNodeInOtherLetters,
		]) {
			expect(asked.code).toBe(64);
			expect(asked.lines).toEqual([
				{ kind: "failed", why: expect.stringContaining("--by") },
			]);
		}
	});

	it("exits 64, saying why, when it is asked wrongly", async () => {
		const one = machine("asked", folder(made, "cache"));

		const asked = await piCarry(one.env, "not-a-quest", "--to", "penelope");

		expect(asked.code).toBe(64);
		expect(asked.lines).toEqual([
			{ kind: "failed", why: expect.stringContaining("Say which quest") },
		]);
	});

	it("exits 64 when settle is asked wrongly, the exit mycelium's settle reads", async () => {
		const one = machine("settle-asked", folder(made, "cache"));

		const asked = await piCarry(one.env, "settle", QUEST);

		expect(asked.code).toBe(64);
		expect(asked.lines).toEqual([
			{ kind: "failed", why: expect.stringContaining("--session") },
		]);
	});

	it("answers --help on stdout alone, exiting 0, with only PATH set", async () => {
		for (const words of [["--help"], ["settle", "not-a-quest", "-h"]]) {
			// run rejects on any exit but 0, so resolving is the exit check.
			const said = await run(
				"node",
				["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT, ...words],
				{ env: { PATH: process.env.PATH } },
			);

			expect(said.stdout, `${words.join(" ")} said its help`).toBe(CARRY_HELP);
			expect(said.stderr, `${words.join(" ")} said nothing else`).toBe("");
		}
	});

	it("says why where and fence couldn't answer on stderr alone", async () => {
		const one = machine("asked", folder(made, "cache"));
		type Ended = { code?: number; stdout?: string; stderr?: string };
		for (const form of ["where", "fence"]) {
			const words = [form, QUEST, "--from", "penelope", "--session", SESSION];
			const ended: Ended = await run(
				"node",
				["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT, ...words],
				{ env: one.env },
			).then(
				(done) => ({ code: 0, ...done }),
				(failed: Ended) => failed,
			);

			expect(ended.code, `${form} couldn't answer`).toBe(1);
			expect(ended.stdout, `${form} printed no answer`).toBe("");
			expect(JSON.parse(ended.stderr ?? ""), `${form} said why`).toEqual({
				kind: "failed",
				why: expect.stringContaining("No done file"),
			});
		}
	});
});
