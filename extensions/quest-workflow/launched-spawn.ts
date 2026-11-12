/**
 * A plain spawn's pi handing itself to the realm's shared host before it
 * draws anything, so quest-workflow's spawnHost setting holds whoever
 * spawned it. The setting is read by the spawner's own code, and a
 * spawner whose pi last loaded the harness before the setting existed
 * hands the desktop's launcher a session as it always did: on 12
 * November every spawn after spawnHost was set to attended at 20:33
 * opened a window, E2ZIAQ's at 00:04 among them (OSPHT4 [331aca88]).
 * The pi the launcher starts runs on the install as it is now, so it
 * decides again here.
 *
 * Only a pi the launcher started for a spawn is taken: started under its
 * own id with `--session-id`, and with the spawn's first words left
 * under that id, which the launcher's hand-over is the only way to have.
 * A spawn that named a terminal, a layout or a nesting never goes to the
 * launcher, so it keeps its window. The rest is spawn's own rule
 * (hostBySetting): a personal realm, no host or nothing listening keeps
 * the window, and the pi says why once it is up.
 *
 * Taken, the host opens a conversation in the same folder, on the same
 * quest and model, told the same first words, and the pi records the
 * host's session as the one that took them, so the spawner's look for
 * its first turn finds it there rather than opening it again. Then the
 * pi ends, and its holder closes the window without a frame drawn in it.
 * A host that turns it away leaves the words where they were, for this
 * pi to say as any spawned pi does.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { HostKind } from "../../host/service/address.ts";
import type { SpawnHostSetting } from "../../lib/core/quest/config.ts";
import { stateDir } from "../../lib/internal/paths.ts";
import {
	firstWordsDir,
	leaveFirstWords,
	recordTaking,
	takeFirstWords,
} from "../../lib/internal/quest/first-words.ts";
import { carriedEnvironment } from "../../lib/internal/session/carried-environment.ts";
import { spawnHostSetting } from "./config.ts";
import { agentCommand } from "./verbs/spawn-held.ts";
import {
	type ControlCall,
	hostBySetting,
	spawnInHost,
} from "./verbs/spawn-host.ts";

/** The variable naming the quest a spawned pi loads as it starts. */
const AUTOLOAD_VARIABLE = "QUEST_WORKFLOW_AUTOLOAD_ID";

/** Thinking levels pi's `--model provider/id:level` may end with. */
const THINKING_LEVELS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

/** A pi the launcher started for a plain spawn, as its start says. */
export interface LaunchedSpawn {
	readonly sessionId: string;
	readonly questId: string;
	readonly cwd: string;
	readonly model?: { readonly provider: string; readonly id: string };
	readonly thinkingLevel?: string;
}

/**
 * The spawn this pi was started for by the launcher, or undefined for any
 * other pi: one with no `--session-id`, no quest to load, or no first
 * words waiting under its id, as a session reopened after its words were
 * taken or dropped has none.
 */
export function launchedSpawn(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
	cwd: string,
	dir: string = firstWordsDir(),
): LaunchedSpawn | undefined {
	const sessionId = flagValue(argv, "--session-id");
	const questId = env[AUTOLOAD_VARIABLE]?.trim();
	if (!(sessionId && questId)) return undefined;
	if (!existsSync(join(dir, `${sessionId}.json`))) return undefined;
	const model = modelOf(flagValue(argv, "--model"));
	return { sessionId, questId, cwd, ...model };
}

/** The value a flag is given, as `--flag value` or `--flag=value`, up to `--`. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
	for (let at = 0; at < argv.length; at += 1) {
		const arg = argv[at] ?? "";
		if (arg === "--") return undefined;
		if (arg === flag) return argv[at + 1];
		if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
	}
	return undefined;
}

/** `provider/id`, with a thinking level after a colon, as spawn words it. */
function modelOf(
	named: string | undefined,
): Pick<LaunchedSpawn, "model" | "thinkingLevel"> {
	if (!named) return {};
	const colon = named.lastIndexOf(":");
	const level = colon < 0 ? undefined : named.slice(colon + 1);
	const thinking = level !== undefined && THINKING_LEVELS.has(level);
	const model = thinking ? named.slice(0, colon) : named;
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) {
		return thinking ? { thinkingLevel: level } : {};
	}
	return {
		model: { provider: model.slice(0, slash), id: model.slice(slash + 1) },
		...(thinking ? { thinkingLevel: level } : {}),
	};
}

/** What handing a launched spawn to its host needs. */
export interface HandFacts {
	/** quest-workflow's spawnHost, read now. */
	readonly setting: () => Promise<{
		setting?: SpawnHostSetting;
		unreadable?: string;
	}>;
	/** The agent command this machine's realm starts its sessions with. */
	readonly agent: () => Promise<string>;
	/** This pi's environment, the one its window started it in. */
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly call?: ControlCall;
	/** Where spawns leave first words. */
	readonly dir?: string;
}

/** Where a launched spawn went: to a host, or staying in its window. */
export type Handed =
	| {
			readonly hosted: true;
			readonly host: string;
			readonly kind: HostKind;
			readonly sessionId: string;
	  }
	| { readonly hosted: false; readonly note?: string };

/**
 * Hand a launched spawn to the host spawnHost names, or say why it
 * stays in its window. The first words go with it and are recorded as
 * taken by the host's session; a host that turns it away gets them put
 * back for this pi.
 */
export async function handToHost(
	spawn: LaunchedSpawn,
	facts: HandFacts,
): Promise<Handed> {
	const choice = await hostBySetting(
		{
			...(await facts.setting()),
			params: { action: "spawn" },
			placedHere: true,
			agent: facts.agent,
			env: facts.env,
		},
		facts.call,
	);
	if (!choice.kind) {
		return choice.note
			? { hosted: false, note: choice.note }
			: { hosted: false };
	}
	const dir = facts.dir ?? firstWordsDir();
	const words = takeFirstWords([spawn.sessionId], dir);
	// Dropped as stale meanwhile: nothing is waiting to start, so it stays.
	if (words === undefined) return { hosted: false };
	const carried = carriedEnvironment({ ...facts.env });
	const opened = await spawnInHost(
		{
			kind: choice.kind,
			questId: spawn.questId,
			cwd: spawn.cwd,
			chosenBy: "the folder its window was opened in",
			first: words,
			...(spawn.model ? { model: spawn.model } : {}),
			...(spawn.thinkingLevel ? { thinkingLevel: spawn.thinkingLevel } : {}),
			...(carried ? { carried } : {}),
			env: facts.env,
		},
		facts.call,
	);
	const sessionId = opened.ok ? opened.details?.sessionId : undefined;
	const host = opened.ok ? opened.details?.host : undefined;
	if (typeof sessionId !== "string" || typeof host !== "string") {
		leaveFirstWords(spawn.sessionId, words, dir);
		const why = opened.ok ? opened.message : opened.guidance;
		return {
			hosted: false,
			note: `quest-workflow.spawnHost is ${choice.kind}, but this spawn stayed in its window: ${why}`,
		};
	}
	recordTaking(spawn.sessionId, { sessionId, said: true }, dir);
	return { hosted: true, host, kind: choice.kind, sessionId };
}

/**
 * As this pi starts, before it draws: when the launcher started it for
 * a plain spawn and spawnHost sends that to a host, hand it there and
 * `end`, which by default ends the process for its holder to close the
 * window. Answers what the pi should say once it is up when it stays,
 * if anything.
 */
export async function settleLaunchedSpawn(
	argv: readonly string[] = process.argv,
	env: Readonly<Record<string, string | undefined>> = process.env,
	end: () => void = () => process.exit(0),
	call?: ControlCall,
): Promise<string | undefined> {
	// A host's conversations never start with --session-id, so a host
	// goes no further and never reads the process's folder.
	if (!flagValue(argv, "--session-id")) return undefined;
	const spawn = launchedSpawn(argv, env, process.cwd());
	if (!spawn) return undefined;
	const machine = hostname().split(".")[0] ?? "";
	const handed = await handToHost(spawn, {
		setting: spawnHostSetting,
		agent: () => agentCommand("pi", machine),
		env,
		...(call ? { call } : {}),
	});
	noteHanded(spawn, handed);
	if (handed.hosted) {
		end();
		return undefined;
	}
	return handed.note;
}

/**
 * Keep a line of what became of a launched spawn, since the pi that
 * hands itself away has no screen left to say it on. Never fails the pi.
 */
export function noteHanded(spawn: LaunchedSpawn, handed: Handed): void {
	const said = handed.hosted
		? `went to the ${handed.host} host as session ${handed.sessionId}`
		: `stayed in its window${handed.note ? `: ${handed.note}` : ""}`;
	try {
		const dir = stateDir("quest-workflow");
		mkdirSync(dir, { recursive: true });
		appendFileSync(
			join(dir, "launched-spawns.log"),
			`${new Date().toISOString()} spawn ${spawn.sessionId} for ${spawn.questId} ${said}\n`,
		);
	} catch {
		// The record is only for a person looking back; the spawn went either way.
	}
}
