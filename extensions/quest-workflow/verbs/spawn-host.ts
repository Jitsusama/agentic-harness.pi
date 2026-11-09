/**
 * Spawn into a shared host: the realm's attended or background pi-durable
 * host opens a fresh conversation for a quest, or adopts the quest's
 * resumable session from its log, over the host's control socket.
 *
 * It is an explicit target, chosen by `host`, never a terminal driver and
 * never a fallback: a host that refuses, or whose answer never arrives,
 * opens nothing else, since a second pi on the same work would split it.
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
	parseOpenResult,
	type SessionIdentity,
} from "../../../host/service/protocol.ts";
import { sessionsDir } from "../../../lib/internal/paths.ts";
import { spawnedWords } from "../../../lib/internal/quest/first-words.ts";
import {
	type SessionView,
	sessionActivity,
} from "../../../lib/internal/quest/session-liveness.ts";
import { uuidv7 } from "../../../lib/internal/session/rollover.ts";
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

/** What a host spawn needs from the spawn that resolved it. */
export interface HostSpawn {
	readonly kind: HostKind;
	readonly questId: string;
	readonly cwd: string;
	/** What chose the folder, as the answer says it. */
	readonly chosenBy: string;
	/** What the new session is told first, when it is fresh. */
	readonly note?: string;
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
	if (!isAbsolute(spawn.cwd)) {
		return refuse(
			`A host opens sessions only in an absolute folder, not "${spawn.cwd}".`,
		);
	}
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
	const screen =
		spawn.kind === "attended"
			? "Its screen waits in the host until a viewer attaches."
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
		...(request.op === "adopt" ? { resumedSessionId: held.sessionId } : {}),
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
			},
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
			first: spawnedWords(spawn.questId, spawn.note),
			...(spawn.model
				? { model: { provider: spawn.model.provider, id: spawn.model.id } }
				: {}),
			...(isThinkingLevel(spawn.thinkingLevel)
				? { thinkingLevel: spawn.thinkingLevel }
				: {}),
		},
	};
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
