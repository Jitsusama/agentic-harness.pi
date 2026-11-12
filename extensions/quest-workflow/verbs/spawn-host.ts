/**
 * Spawn into a shared host: the realm's attended or background pi-durable
 * host opens a fresh conversation for a quest, or adopts the quest's
 * resumable session from its log, over the host's control socket.
 *
 * It is a target chosen by `host`, or for a plain spawn by quest-workflow's
 * spawnHost setting; never a terminal driver and never a fallback: a host
 * that refuses, or whose answer never arrives, opens nothing else, since a
 * second pi on the same work would split it. Only a host that isn't there
 * at all, under the setting, leaves the spawn to its terminal.
 *
 * /quest-resume in a hosted conversation goes this way too, through
 * resumeInHost, since a host's conversation can't switch its own log.
 */

import { isAbsolute } from "node:path";
import {
	type HostKind,
	hostKey,
	hostRealm,
	hostSocketPath,
} from "../../../host/service/address.ts";
import { controlRequest } from "../../../host/service/client.ts";
import {
	type ControlRequest,
	parseAdoptResult,
	parseListResult,
	parseOpenResult,
	type SessionIdentity,
} from "../../../host/service/protocol.ts";
import type { SpawnHostSetting } from "../../../lib/core/quest/config.ts";
import { sessionsDir } from "../../../lib/internal/paths.ts";
import { spawnedWords } from "../../../lib/internal/quest/first-words.ts";
import {
	type SessionView,
	sessionActivity,
} from "../../../lib/internal/quest/session-liveness.ts";
import type { CarriedEnvironment } from "../../../lib/internal/session/carried-environment.ts";
import {
	attachWords,
	type HostHold,
	heldByHost,
	holdOf,
	hostHold,
} from "../../../lib/internal/session/host-holds.ts";
import { uuidv7 } from "../../../lib/internal/session/uuidv7.ts";
import { spawnHostSetting } from "../config.ts";
import { readRecord } from "../session-registry.ts";
import {
	ok,
	type QuestResult,
	type QuestToolParams,
	refuse,
} from "./shared.ts";

/** Sends one control request to a host's socket and reads its reply. */
export type ControlCall = typeof controlRequest;

type OpenRequest = Extract<ControlRequest, { op: "open" }>;
type ThinkingLevel = NonNullable<OpenRequest["thinkingLevel"]>;

const THINKING_LEVELS: ReadonlySet<string> = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
	return value !== undefined && THINKING_LEVELS.has(value);
}

/** Errors a connection gives before any request is written. */
const NEVER_SENT = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);

/**
 * The host a spawn asks for, or why it can't be one. Undefined when the
 * call names none. A host spawn opens no window, so every parameter that
 * shapes a terminal, places the session elsewhere or runs another command
 * is refused beside it rather than quietly ignored.
 */
export function hostTargetOf(
	params: QuestToolParams,
): { ok: true; kind?: HostKind } | { ok: false; refusal: string } {
	const asked = params.host?.trim();
	if (!asked) return { ok: true };
	if (asked !== "attended" && asked !== "background") {
		return {
			ok: false,
			refusal: `host is attended or background, not "${asked}".`,
		};
	}
	const clashing = [
		params.action !== "spawn" ? params.action : undefined,
		params.terminal?.trim() ? "terminal" : undefined,
		params.layout?.trim() ? "layout" : undefined,
		params.nesting?.trim() ? "nesting" : undefined,
		params.machine?.trim() ? "machine" : undefined,
		params.needs !== undefined ? "needs" : undefined,
		params.command?.trim() ? "command" : undefined,
	].filter((name): name is string => name !== undefined);
	if (clashing.length > 0) {
		return {
			ok: false,
			refusal: `A host spawn opens no terminal and runs the host's own pi on this machine, so ${clashing.join(", ")} can't go with host; use spawn with host alone.`,
		};
	}
	return { ok: true, kind: asked };
}

/** What a plain spawn needs to know to follow the spawnHost setting. */
export interface SettingSpawn {
	/** quest-workflow's spawnHost, undefined when unset. */
	readonly setting?: SpawnHostSetting;
	/** Why the setting couldn't be read, when it couldn't. */
	readonly unreadable?: string;
	readonly params: QuestToolParams;
	/** Whether the spawn starts on this machine, the only one a host is on. */
	readonly placedHere: boolean;
	/** The agent command this machine's realm starts its sessions with. */
	readonly agent: () => Promise<string>;
	/** The asking conversation's environment, never the host process's. */
	readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * The host the spawnHost setting sends a plain spawn to, with a note for
 * its answer either way. A spawn that names a terminal, a layout, a
 * machine, needs or a command, or a suffixed verb, goes as it says, and
 * so does one placed on another machine or in a realm whose sessions
 * start an agent other than pi, which no host runs. A host that isn't
 * there, with no realm or socket or nothing listening on it, leaves the
 * spawn to its terminal and says so; any other answer counts as there,
 * so a host that then refuses opens nothing else.
 */
export async function hostBySetting(
	spawn: SettingSpawn,
	call: ControlCall = controlRequest,
): Promise<{ kind?: HostKind; note?: string }> {
	const { setting, params } = spawn;
	if (!plainSpawn(params)) return {};
	if (spawn.unreadable) {
		return {
			note: `quest-workflow.spawnHost was left off, since the config says what it can't read: ${spawn.unreadable}.`,
		};
	}
	if (setting === undefined || setting === "off") return {};
	const said = `quest-workflow.spawnHost is ${setting}`;
	if (!spawn.placedHere) {
		return {
			note: `${said}, but this quest's needs place it on another machine, where no host of this one's runs it, so it opens there in a terminal.`,
		};
	}
	const agent = (await spawn.agent()).split(" ")[0] ?? "pi";
	if (agent !== "pi") {
		return {
			note: `${said}, but this realm starts ${agent} for its sessions, which no host runs, so it opens in a terminal.`,
		};
	}
	let key: string;
	let socket: string;
	try {
		const realm = hostRealm(spawn.env);
		key = hostKey(realm, setting);
		socket = hostSocketPath(realm, setting, spawn.env.XDG_RUNTIME_DIR);
	} catch (error) {
		return {
			note: `${said}, but there's no host here (${messageOf(error)}), so it opens in a terminal.`,
		};
	}
	try {
		await call(socket, { v: 1, id: uuidv7(), op: "list" });
	} catch (error) {
		if (neverSent(error)) {
			return {
				note: `${said}, but no ${key} host is listening at ${socket}, so it opens in a terminal.`,
			};
		}
		// Anything else, such as a host too busy to list in time, is a host
		// that is there, so its own answer to the spawn decides.
	}
	return {
		kind: setting,
		note: `${said}, so it went to the host; name a terminal or a layout, or use spawn-tab, to open a window instead.`,
	};
}

/** What spawn has resolved, for the host it may go to. */
export interface HostChoice {
	/** The host the call named, if it named one. */
	readonly asked?: HostKind;
	readonly params: QuestToolParams;
	/** The machine the quest's needs place it on, when not this one. */
	readonly elsewhere?: string;
	/** The agent command this machine's realm starts its sessions with. */
	readonly agent: () => Promise<string>;
	/** The spawn to send, once a host is chosen. */
	readonly spawn: Omit<HostSpawn, "kind">;
}

/**
 * Spawn in the host the call names, or the one spawnHost sends a plain
 * spawn to, with the setting's note on its answer; or, when neither
 * chooses one, the note a terminal answer ends with, empty or saying
 * why the setting's host didn't take it.
 */
export async function spawnByHost(
	choice: HostChoice,
	call: ControlCall = controlRequest,
): Promise<{ result: QuestResult } | { terminalNote: string }> {
	const { spawn } = choice;
	if (choice.asked) {
		// The host is this machine's, so a quest its needs place elsewhere
		// can't be hosted here.
		if (choice.elsewhere) {
			return {
				result: refuse(
					`${spawn.questId}'s needs place it on ${choice.elsewhere}, and a host spawn opens here only; spawn it without host to start it there.`,
				),
			};
		}
		return {
			result: await spawnInHost({ ...spawn, kind: choice.asked }, call),
		};
	}
	// Read now, so turning it on or off takes at the next spawn.
	const bySetting = await hostBySetting(
		{
			...(await spawnHostSetting()),
			params: choice.params,
			placedHere: choice.elsewhere === undefined,
			agent: choice.agent,
			env: spawn.env,
		},
		call,
	);
	const note = bySetting.note ? ` ${bySetting.note}` : "";
	if (!bySetting.kind) return { terminalNote: note };
	const hosted = await spawnInHost({ ...spawn, kind: bySetting.kind }, call);
	return {
		result: hosted.ok
			? { ...hosted, message: `${hosted.message}${note}` }
			: { ...hosted, guidance: `${hosted.guidance}${note}` },
	};
}

/** A bare spawn that names nothing a host spawn refuses beside it. */
function plainSpawn(params: QuestToolParams): boolean {
	return (
		params.action === "spawn" &&
		!params.host?.trim() &&
		!params.terminal?.trim() &&
		!params.layout?.trim() &&
		!params.nesting?.trim() &&
		!params.machine?.trim() &&
		params.needs === undefined &&
		!params.command?.trim()
	);
}

/** What a host spawn needs from the spawn that resolved it. */
export interface HostSpawn {
	readonly kind: HostKind;
	readonly questId: string;
	readonly cwd: string;
	/** What chose the folder, as the answer says it. */
	readonly chosenBy: string;
	/** What the new session is told first, when it is fresh. */
	readonly note?: string;
	/**
	 * The first words as a spawn already left them, in place of the note's,
	 * for a launched spawn handing itself on (launched-spawn.ts).
	 */
	readonly first?: string;
	/** How a fresh session runs its commands, as the pi it stands for did. */
	readonly carried?: CarriedEnvironment;
	/** The session to adopt, as the spawn picked it, with its liveness. */
	readonly resume?: SessionView;
	/** The asking session's model, carried to a fresh one. */
	readonly model?: { readonly provider: string; readonly id: string };
	readonly thinkingLevel?: string;
	/** The asking conversation's environment, never the host process's. */
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly dryRun?: boolean;
	/** Where pi keeps session logs; the home's by default. */
	readonly logs?: string;
}

/**
 * Open or adopt the quest's session in the realm's host. A fresh session
 * is opened with its first words in the request itself, so it sets to
 * work at once; a resumed one is adopted from its log and told nothing,
 * since adopt carries no first words and a later prompt sent apart from
 * it could land on another run.
 */
export async function spawnInHost(
	spawn: HostSpawn,
	call: ControlCall = controlRequest,
): Promise<QuestResult> {
	let realm: string;
	let socket: string;
	try {
		realm = hostRealm(spawn.env);
		socket = hostSocketPath(realm, spawn.kind, spawn.env.XDG_RUNTIME_DIR);
	} catch (error) {
		return refuse(`No ${spawn.kind} host to spawn into: ${messageOf(error)}.`);
	}
	const key = hostKey(realm, spawn.kind);
	const built = requestFor(spawn);
	if (!built.ok) return refuse(built.refusal);
	const { request } = built;
	const what =
		request.op === "adopt"
			? `adopt session ${spawn.resume?.id} from ${request.sessionFile}`
			: `open a fresh session in ${spawn.cwd} (${spawn.chosenBy}), told to carry on with ${spawn.questId}`;
	if (spawn.dryRun) {
		return ok(`Would ask the ${key} host at ${socket} to ${what}.`, {
			how: "host",
			host: key,
			socket,
			request,
		});
	}
	let reply: Awaited<ReturnType<ControlCall>>;
	try {
		reply = await call(socket, request);
	} catch (error) {
		if (neverSent(error)) {
			return refuse(
				`No ${key} host is listening at ${socket}, so nothing was opened.`,
			);
		}
		return refuse(unknownOutcome(key, messageOf(error)));
	}
	if (!reply.ok) {
		return refuse(
			`The ${key} host refused to ${what}: ${reply.error.code}, ${reply.error.message}. Nothing else was opened.`,
		);
	}
	let held: SessionIdentity;
	try {
		held =
			request.op === "adopt"
				? parseAdoptResult(reply.result)
				: parseOpenResult(reply.result);
	} catch {
		return refuse(
			unknownOutcome(key, "it said yes, but what it opened is unreadable"),
		);
	}
	const attach =
		spawn.kind === "attended"
			? attachWords(holdOf(key, true), held.sessionId)
			: undefined;
	const screen = attach
		? `Its screen waits in the host until a viewer attaches: ${attach.join(" ")}`
		: "It runs in the background, with no screen.";
	const said =
		request.op === "adopt"
			? `The ${key} host adopted session ${held.sessionId}, which picks up its own history in ${held.cwd}; it isn't told anything, so it waits where its log stopped. ${screen}`
			: `The ${key} host opened session ${held.sessionId} in ${held.cwd} (${spawn.chosenBy}), which loads ${spawn.questId} and was told to carry on. ${screen}`;
	return ok(said, {
		how: "host",
		host: key,
		sessionId: held.sessionId,
		file: held.file,
		cwd: held.cwd,
		state: held.state,
		since: held.since,
		attended: spawn.kind === "attended",
		autoloadQuestId: spawn.questId,
		...(attach ? { attach } : {}),
		...(request.op === "adopt" ? { resumedSessionId: held.sessionId } : {}),
	});
}

/** What /quest-resume in a hosted conversation needs to carry a session on. */
export interface HostResume {
	readonly questId: string;
	/** The quest's record of the session, with its liveness. */
	readonly session: SessionView;
	/** The asking conversation's environment, never the host process's. */
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Where pi keeps session logs; the home's by default. */
	readonly logs?: string;
}

/**
 * Carry a quest's session on in the realm's attended host, since a
 * resume is for a person to look at. A session the host already holds
 * is only pointed at; any other is adopted from its log, with spawn's
 * refusals (live elsewhere, no log). Either way the answer says how to
 * view it, and adopted says which happened.
 */
export async function resumeInHost(
	resume: HostResume,
	call: ControlCall = controlRequest,
	holdOfSession: (
		sessionId: string,
	) => Promise<HostHold | undefined> = hostHold,
): Promise<QuestResult> {
	const kind = "attended";
	const { session } = resume;
	let realm: string;
	let socket: string;
	try {
		realm = hostRealm(resume.env);
		socket = hostSocketPath(realm, kind, resume.env.XDG_RUNTIME_DIR);
	} catch (error) {
		return refuse(`No ${kind} host to resume into: ${messageOf(error)}.`);
	}
	const key = hostKey(realm, kind);
	// A host holding it is the only writer it may have: another host, or
	// this one's roster while it is down or starting, takes it up again
	// itself, so adopting it here would make a second. Only this host
	// having it open is left to its list, which says so.
	const elsewhere = await holdOfSession(session.id);
	if (elsewhere && !(elsewhere.key === key && elsewhere.open))
		return reachedInHost(session.id, elsewhere);
	let reply: Awaited<ReturnType<ControlCall>>;
	try {
		reply = await call(socket, { v: 1, id: uuidv7(), op: "list" });
	} catch (error) {
		if (neverSent(error)) {
			return refuse(
				`No ${key} host is listening at ${socket}, so nothing was opened.`,
			);
		}
		return refuse(
			`The ${key} host didn't say what it holds (${messageOf(error)}), so nothing was adopted.`,
		);
	}
	if (!reply.ok) {
		return refuse(
			`The ${key} host refused to list what it holds: ${reply.error.code}, ${reply.error.message}. Nothing was adopted.`,
		);
	}
	let holds: boolean;
	try {
		holds = parseListResult(reply.result).sessions.some(
			(held) => held.sessionId === session.id,
		);
	} catch {
		return refuse(
			`The ${key} host's list is unreadable, so nothing was adopted.`,
		);
	}
	if (holds) {
		const attach = attachWords(holdOf(key, true), session.id);
		return ok(
			`The ${key} host already holds session ${session.id}, so nothing was adopted. View it: ${attach.join(" ")}`,
			{ how: "host", host: key, sessionId: session.id, adopted: false, attach },
		);
	}
	const adopted = await spawnInHost(
		{
			kind,
			questId: resume.questId,
			cwd: session.cwd ?? "",
			chosenBy: "the session's own folder",
			resume: session,
			env: resume.env,
			...(resume.logs ? { logs: resume.logs } : {}),
		},
		call,
	);
	if (!adopted.ok) return adopted;
	return { ...adopted, details: { ...adopted.details, adopted: true } };
}

/**
 * The answer for a conversation a host holds: nothing opened, and how to
 * reach it through that host.
 */
export function reachedInHost(sessionId: string, hold: HostHold): QuestResult {
	return ok(heldByHost(sessionId, hold), {
		how: "hosted",
		host: hold.key,
		sessionId,
		open: hold.open,
		adopted: false,
		attach: attachWords(hold, sessionId),
	});
}

/**
 * The request a spawn sends: adopt for a resumable session, open
 * otherwise. A session still live elsewhere is never adopted, since its
 * log would gain a second writer, and a note can't be told to an adopted
 * one; both refuse rather than start something else.
 */
function requestFor(
	spawn: HostSpawn,
): { ok: true; request: ControlRequest } | { ok: false; refusal: string } {
	const envelope = { v: 1 as const, id: uuidv7() };
	const attended = spawn.kind === "attended";
	const resumed = spawn.resume;
	if (resumed) {
		if (resumed.liveness === "live") {
			return {
				ok: false,
				refusal: `Session ${resumed.id} is still live, so adopting its log would give it a second writer; nothing was opened. End it first, or detach it from the quest to start fresh.`,
			};
		}
		if (spawn.note?.trim()) {
			return {
				ok: false,
				refusal: `Session ${resumed.id} would be adopted, and a host adopts a session without first words, so the note can't reach it; nothing was opened. Spawn without a note, or detach it from the quest to start fresh.`,
			};
		}
		const found = sessionActivity(resumed.id, spawn.logs ?? sessionsDir());
		if (!found) {
			return {
				ok: false,
				refusal: `Session ${resumed.id} has no log on this machine for the host to adopt; nothing was opened.`,
			};
		}
		return {
			ok: true,
			request: {
				...envelope,
				op: "adopt",
				sessionFile: found.path,
				attended,
				quest: spawn.questId,
				// Run its commands as it last ran them, as a reopen after a reboot does.
				...ranWith(resumed.id),
			},
		};
	}
	// Only a fresh session is opened in a folder; an adopted one keeps its own.
	if (!isAbsolute(spawn.cwd)) {
		return {
			ok: false,
			refusal: `A host opens sessions only in an absolute folder, not "${spawn.cwd}".`,
		};
	}
	return {
		ok: true,
		request: {
			...envelope,
			op: "open",
			cwd: spawn.cwd,
			attended,
			quest: spawn.questId,
			first: spawn.first ?? spawnedWords(spawn.questId, spawn.note),
			...(spawn.carried ? { env: spawn.carried } : {}),
			...(spawn.model
				? { model: { provider: spawn.model.provider, id: spawn.model.id } }
				: {}),
			...(isThinkingLevel(spawn.thinkingLevel)
				? { thinkingLevel: spawn.thinkingLevel }
				: {}),
		},
	};
}

/** How a session's record says it ran its commands, for its adopt. */
function ranWith(sessionId: string): { env?: CarriedEnvironment } {
	const env = readRecord(sessionId)?.env;
	return env ? { env } : {};
}

function neverSent(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	return typeof error.code === "string" && NEVER_SENT.has(error.code);
}

function unknownOutcome(key: string, why: string): string {
	return `The ${key} host gave no answer to trust (${why}), so whether it opened the session is unknown. Nothing else was opened and nothing was retried; check the host's list before spawning again.`;
}

function messageOf(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\.$/, "");
}
