/**
 * Which pis the agent fence takes by default while it rolls out in
 * stages (ISXEG8's reshape [0ed98522], stage 1 from Mon 16 November):
 * a fleet's subagents, the sessions `quest spawn` starts fresh, and the
 * sessions named for it by hand. Everyone else runs as before until the
 * everyone stage, and a reopen joins only then, since a reopened
 * attended session would fence Joel's own typing [1309c590].
 *
 * The default is worked out from how the pi was started and never
 * written into its environment, so a reload, a park file or a session's
 * record carries nothing forward: on 13 November a default written into
 * process.env outlived its revert in every running pi.
 *
 * A session is listed by a file under pi's state, which only pi writes,
 * from outside the fence: inside, pi's whole state folder is read-only
 * (#1550), so no command can unlist its own session. The launcher hands
 * a spawn on with nothing but its id, so the id is all a listing can go
 * by. A spawn whose id isn't known until it starts (a terminal's pi, a
 * host's conversation) is listed by a token in its environment instead
 * (`PI_FENCE_STAGE`), which names a listing only pi wrote, so a token
 * alone fences nothing; as it starts, its session is listed by id too,
 * so reopening it by id keeps it fenced as it first ran.
 */

import {
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { stateDir } from "./paths.ts";
import { uuidv7 } from "./session/uuidv7.ts";

/** The variable naming a fresh spawn's listing, before its id is known. */
export const STAGE_VARIABLE = "PI_FENCE_STAGE";

/** A session id as pi mints it, or anything that could leave the folder. */
const SESSION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id at the end of a session log's name, as pi names its logs. */
const LOG_ID =
	/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Where the sessions listed for the fence's first stage are kept. */
export function stageFolder(): string {
	return stateDir("fence-stage");
}

/** Whether this pi is a fleet's subagent, as its supervisor marks it. */
export function isSubagent(env: NodeJS.ProcessEnv): boolean {
	return env.SUBAGENT_SUPERVISOR === "1" || Boolean(env.SUBAGENT_RUN_ID);
}

/** The value given `flag` on a command line, as `--flag v` or `--flag=v`. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
	for (let at = 0; at < argv.length; at += 1) {
		const arg = argv[at] ?? "";
		if (arg === "--") return undefined;
		if (arg === flag) return argv[at + 1];
		if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
	}
	return undefined;
}

/**
 * The session this pi runs, as it was started: its command line's
 * `--session-id`, or the session `--session` reopens, by id or by its
 * log's name, and else the conversation a host gives it. The command
 * line comes first, since a pi a command started inherits the asking
 * session's PI_SESSION_ID along with the rest of its environment.
 */
export function startedSession(
	env: NodeJS.ProcessEnv,
	argv: readonly string[] = process.argv,
): string | undefined {
	const named =
		flagValue(argv, "--session-id") ?? flagValue(argv, "--session") ?? "";
	const id = LOG_ID.exec(basename(named))?.[1] ?? named;
	if (SESSION_ID.test(id)) return id.toLowerCase();
	const hosted = env.PI_SESSION_ID?.trim() ?? "";
	return SESSION_ID.test(hosted) ? hosted.toLowerCase() : undefined;
}

/** Whether `session` is listed for the fence's first stage. */
export function listedForStage(
	session: string | undefined,
	folder: string = stageFolder(),
): boolean {
	if (!session || !SESSION_ID.test(session)) return false;
	return (
		statSync(join(folder, `${session.toLowerCase()}.json`), {
			throwIfNoEntry: false,
		})?.isFile() ?? false
	);
}

/**
 * List `session` for the fence's first stage, saying why, so its pi
 * starts fenced. Written whole before it is seen.
 */
export function listForStage(
	session: string,
	why: string,
	folder: string = stageFolder(),
	now: Date = new Date(),
): void {
	if (!SESSION_ID.test(session)) {
		throw new Error(`not a session id: ${session}`);
	}
	mkdirSync(folder, { recursive: true });
	const path = join(folder, `${session.toLowerCase()}.json`);
	const writing = `${path}.writing`;
	writeFileSync(
		writing,
		`${JSON.stringify({ v: 1, why, at: now.toISOString() })}\n`,
	);
	renameSync(writing, path);
}

/**
 * Take `session` off the first stage, so its pi starts as before once it
 * starts again; answers whether it was listed.
 */
export function unlistForStage(
	session: string,
	folder: string = stageFolder(),
): boolean {
	if (!listedForStage(session, folder)) return false;
	rmSync(join(folder, `${session.toLowerCase()}.json`));
	return true;
}

/** Every session or spawn listed for the first stage. */
export function stagedSessions(folder: string = stageFolder()): string[] {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		// No folder yet: nothing has been listed.
		return [];
	}
	return names
		.filter((name) => name.endsWith(".json"))
		.map((name) => name.slice(0, -".json".length))
		.filter((id) => SESSION_ID.test(id))
		.sort();
}

/**
 * List a fresh spawn for the first stage before it starts, answering the
 * token its environment names it by (`STAGE_VARIABLE`).
 */
export function listSpawnForStage(
	why: string,
	folder: string = stageFolder(),
	now: Date = new Date(),
): string {
	const token = uuidv7(now.getTime());
	listForStage(token, why, folder, now);
	return token;
}

/**
 * List `session` by its id once it starts, where the token it was
 * spawned with is listed, so a reopen by id starts fenced as it first
 * ran. Answers whether it listed it.
 */
export function settleStage(
	env: NodeJS.ProcessEnv,
	session: string,
	folder: string = stageFolder(),
	now: Date = new Date(),
): boolean {
	const token = env[STAGE_VARIABLE]?.trim();
	if (!token || !listedForStage(token, folder)) return false;
	if (!SESSION_ID.test(session) || listedForStage(session, folder)) {
		return false;
	}
	listForStage(session, `spawned listed as ${token}`, folder, now);
	return true;
}

/** The value that runs one session's commands as they are. */
export const OFF = "off";

/**
 * `env` as a pi it starts is to be given it: without `PI_SANDBOX=off`,
 * which is one session's way back and never what it starts (ISXEG8
 * [8599528b]), so a subagent or a fresh spawn of a session set off is
 * fenced as the stage says. Any other value goes on as it is, a fence
 * asked for included; `env` itself when there is nothing to drop.
 */
export function withoutOff(
	env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
	if (env.PI_SANDBOX?.trim() !== OFF) return env;
	const { PI_SANDBOX: _off, ...rest } = env;
	return rest;
}

/**
 * The sandbox this pi's commands run in, by name, from `PI_SANDBOX` and
 * the stage: a name `known` holds as given; `off`, or nothing asked of a
 * pi outside the stage, as they are; nothing asked of a pi in it, the
 * fence. Anything else, empty included, reads as the fence, with a note
 * saying so: refusing would stop every command of a session a stray
 * `PI_SANDBOX=` reached, and the fence fails closed and keeps it working
 * (ISXEG8 [1309c590]).
 */
export function askedSandbox(
	env: NodeJS.ProcessEnv,
	names: { readonly fence: string; readonly known: readonly string[] },
	staged: (env: NodeJS.ProcessEnv) => boolean = inFirstStage,
): { readonly name?: string; readonly note?: string } {
	const given = env.PI_SANDBOX;
	if (given === undefined) return staged(env) ? { name: names.fence } : {};
	const asked = given.trim();
	if (asked === OFF) return {};
	if (names.known.includes(asked)) return { name: asked };
	return {
		name: names.fence,
		note: `PI_SANDBOX=${JSON.stringify(given)} names no sandbox, so it was read as ${names.fence}; set PI_SANDBOX=${OFF} to run this session's commands as they are.`,
	};
}

/**
 * Whether the fence takes this pi by default: a subagent, or a session
 * listed for the first stage, by its id or its spawn's token.
 */
export function inFirstStage(
	env: NodeJS.ProcessEnv,
	argv: readonly string[] = process.argv,
	folder: string = stageFolder(),
): boolean {
	return (
		isSubagent(env) ||
		listedForStage(startedSession(env, argv), folder) ||
		listedForStage(env[STAGE_VARIABLE]?.trim(), folder)
	);
}
