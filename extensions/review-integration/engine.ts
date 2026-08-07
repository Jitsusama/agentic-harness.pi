/**
 * Building the engine, once per session.
 *
 * The library takes an exec and a store as dependencies, which
 * is what keeps it testable; this is where pi's own exec and
 * this package's state directory get supplied. The engine is
 * cached because a session asks it for many things, and rebuilt
 * only when the configuration it was built from changes.
 */

import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stateDir } from "../../lib/internal/paths.js";
import {
	type AttachmentStore,
	createAttachmentStore,
	createDraftStore,
	createGitHubProvider,
	createGitProvider,
	createReviewEngine,
	type Exec,
	type ReviewEngine,
	registerReviewProvider,
} from "../../lib/review/index.js";
import { loadReviewConfig } from "./config.js";

/** Where drafts live. */
export function draftDir(): string {
	return join(stateDir("review"), "drafts");
}

/** Where the changes a session is attached to live. */
export function attachmentDir(): string {
	return join(stateDir("review"), "attached");
}

/**
 * Which session is asking, so its attachments stay its own.
 *
 * Held here rather than threaded through every call, because every tool
 * in this extension needs it and none of them otherwise needs to know a
 * session exists. Always answers something, so no two callers can share
 * a directory by both having nothing to say.
 */
export function sessionKey(): string {
	return inSession;
}

/**
 * Until pi says otherwise, this process.
 *
 * The store's flat fallback was justified by "a caller with no session
 * cannot be racing one", which held while the value was fixed for the
 * life of the process. It arrives on an event now, so absent means not
 * told yet rather than no session, and that resolves to exactly the
 * shared directory that retargeted a live council. Pi itself always has
 * a session id, an in-memory one included, so this is the window before
 * the event and a host that never sends it, not an ephemeral session.
 *
 * Anonymous is therefore not communal. The name carries a pid to say
 * what it is and a random tail because a pid is only exclusive among
 * living processes: the directory outlives the process by a month, and
 * a later process landing on the same number would open onto the
 * earlier one's attachments, which is this bug one directory wide.
 */
let inSession = anonymous();

function anonymous(): string {
	return `process-${process.pid}-${randomUUID().slice(0, 8)}`;
}

/**
 * Remember which session this is, as pi reports it.
 *
 * It used to be read from `PI_SESSION_ID`, which reads like the answer
 * and is not one: pi injects that variable when the bash tool spawns a
 * command, and never sets it in its own process, so an extension asking
 * for it always gets undefined. The scoping was therefore off from the
 * day it shipped, silently, because undefined means "no session to
 * separate" and that is a legitimate state.
 *
 * Called from `session_start`, which pi fires on startup and again on
 * every reload, resume and fork, so a session that becomes another one
 * stops answering for the first.
 */
export function rememberSession(sessionId: string | undefined): void {
	// A session that reports no id is pi saying there is none, which is
	// not the same as pi not having said yet. Carrying the last name
	// forward would write this session's work into the last one's
	// directory, so it goes back to being anonymous instead.
	inSession =
		sessionId === undefined || sessionId.trim() === ""
			? anonymous()
			: sessionId;
}

/**
 * This session's attachments.
 *
 * One way in, so a new call site cannot reach the store without
 * saying which session is asking. The six that existed each built it
 * themselves, and a seventh built the same way would have quietly
 * shared its attachments with every other session on the machine.
 */
export function attachments(): AttachmentStore {
	return createAttachmentStore(attachmentDir(), sessionKey());
}

/**
 * Whose session a session file is, as pi wrote it.
 *
 * The header, and only the header. The name carries the id too, as a
 * timestamp and an id joined by an underscore, and reading that was
 * tried: it is the one branch that can hand this session a stranger's
 * attachments, and it fires exactly when the file is unreadable, which
 * is when least is known. The argument for preferring the header is
 * that a name is a shape that can change and that a person can break
 * by renaming; falling back to it when the header will not read trusts
 * the thing the argument just rejected. A fork that cannot identify
 * its parent starts empty, which is where every fork started before.
 *
 * Bounded. A session file is an append-only transcript and can run to
 * megabytes, so reading the whole of it to take the first line would
 * make a fork pay for the length of the conversation it came from.
 *
 * The record has to say it is a session. Any object with a string id
 * would otherwise do, and the first line of something that is not a
 * session file is exactly where a plausible wrong answer lives.
 */
export async function sessionIdIn(file: string): Promise<string | undefined> {
	let head: string;
	try {
		head = await firstBytes(file, SESSION_HEADER_MAX_BYTES);
	} catch {
		// Gone, unreadable, or not a file. Nothing to inherit from.
		return undefined;
	}
	const [line] = head.split("\n", 1);
	if (line === undefined || line.trim() === "") return undefined;
	let header: unknown;
	try {
		header = JSON.parse(line);
	} catch {
		// Not a header: half-written, or a file that is not pi's.
		return undefined;
	}
	if (typeof header !== "object" || header === null) return undefined;
	const record = header as { type?: unknown; id?: unknown };
	if (record.type !== "session") return undefined;
	return typeof record.id === "string" && record.id !== ""
		? record.id
		: undefined;
}

/**
 * How much of a session file to read looking for its header.
 *
 * Pi's own header is a couple of hundred bytes. This is generous
 * enough for one that grows a field and small enough that a huge
 * transcript costs one read.
 */
const SESSION_HEADER_MAX_BYTES = 64 * 1024;

/** The first bytes of a file, without reading the rest of it. */
async function firstBytes(file: string, limit: number): Promise<string> {
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(limit);
		const { bytesRead } = await handle.read(buffer, 0, limit, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

/** Where findings raised against a change live. */
export function findingDir(): string {
	return join(stateDir("review"), "findings");
}

/** Where the rounds asked about a change live. */
export function runDir(): string {
	return join(stateDir("review"), "runs");
}

/**
 * Where a round's reviewers leave their transcripts.
 *
 * Beside the ledger rather than inside it: the ledger is a small file
 * read on every listing, and these are megabytes of event stream per
 * reviewer. The round id is the key on both sides, so one points at
 * the other without either having to hold the other's contents.
 */
export function runArtifactDir(): string {
	return join(stateDir("review"), "transcripts");
}

/**
 * Where what each reviewer said is kept, verbatim.
 *
 * Separate from the transcripts because it outlives them: a
 * transcript belongs to the runner and its retention, and a finding's
 * provenance has to survive that housekeeping.
 */
export function answerDir(): string {
	return join(stateDir("review"), "answers");
}

/** Where findings queued to fix rather than say live. */
export function fixDir(): string {
	return join(stateDir("review"), "fixes");
}

/** Where the record of what has been settled lives. */
export function decisionDir(): string {
	return join(stateDir("review"), "decisions");
}

/** Where the record of reviews you have posted lives. */
export function visitDir(): string {
	return join(stateDir("review"), "visits");
}

/**
 * Where persona charters are read from.
 *
 * Beside the config a person edits rather than under the state
 * directory, because a persona is something somebody writes and argues
 * with, not something the tool accumulates. `REVIEW_PERSONAS_DIR`
 * wins, then `$XDG_CONFIG_HOME/pi/personas`, then
 * `~/.config/pi/personas`.
 */
export function personaDir(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): string {
	const explicit = env.REVIEW_PERSONAS_DIR;
	if (explicit !== undefined && explicit.trim() !== "") return explicit;
	const xdg = env.XDG_CONFIG_HOME;
	if (xdg !== undefined && xdg.trim() !== "") {
		return join(xdg, "pi", "personas");
	}
	return join(home, ".config", "pi", "personas");
}

/** Adapt pi's exec to the library's seam. */
function execFor(pi: ExtensionAPI): Exec {
	return async (command, args) => {
		const result = await pi.exec(command, args);
		return {
			code: result.code,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	};
}

/** What the session holds. */
interface Session {
	engine: ReviewEngine;
	problems: string[];
}

let session: Session | undefined;

/**
 * Register the providers this package ships. Idempotent, since
 * the registry survives module reimport but not a reload.
 */
export function registerBuiltinReviewProviders(pi: ExtensionAPI): void {
	const exec = execFor(pi);
	registerReviewProvider(createGitHubProvider({ exec }));
	registerReviewProvider(createGitProvider({ exec }));
}

/** The session's engine, built on first use. */
export async function reviewEngine(pi: ExtensionAPI): Promise<Session> {
	if (session) return session;
	const { config, problems } = await loadReviewConfig();
	session = {
		engine: createReviewEngine({
			exec: execFor(pi),
			store: createDraftStore(draftDir()),
			...(Object.keys(config).length > 0 ? { config } : {}),
		}),
		problems,
	};
	return session;
}

/** Drop the cached engine, so the next call rereads config. */
export function forgetReviewEngine(): void {
	session = undefined;
}
