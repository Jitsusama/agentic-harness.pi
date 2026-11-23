/**
 * Where each conversation a host runs is running: in a process of its
 * own, a child whose systemd unit runs, or on the host's own thread,
 * where one stalled conversation stalls every other. It is the live
 * measure of moving conversations off the host's thread, read from the
 * host's list, systemd and the children's slot files, changing nothing.
 * Node runs it as it stands, stripping the types:
 *
 *   node scripts/where-sessions-run.ts [attended|background]...
 *
 * Without a kind it reads both hosts. A host that doesn't answer, or
 * whose units systemd won't list, is said and the next is read; exits 1
 * when any wasn't read, 0 otherwise.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
	type HostKind,
	hostKey,
	hostRealm,
	hostSocketPath,
} from "../host/service/address.ts";
import {
	SYSTEMCTL_WITHIN_MS,
	slotFolder,
	slotHolds,
	slotOf,
} from "../host/service/child-units.ts";
import { controlRequest } from "../host/service/client.ts";
import {
	parseListResult,
	type SessionIdentity,
} from "../host/service/protocol.ts";
import { isSessionId } from "../lib/core/session/roster.ts";
import { runtimeDir as loginRuntimeDir } from "../lib/internal/paths.ts";

/** One conversation a host listed, and whether it has a process of its own. */
export interface WhereItRuns {
	readonly sessionId: string;
	readonly state: SessionIdentity["state"];
	readonly cwd: string;
	/** A running child of this host's runs it, off the host's thread. */
	readonly own: boolean;
}

/**
 * The slots of host `key`'s child units in systemctl's plain listing
 * `listed`, one unit a line; another host's units and any line that
 * names no slot are left out.
 */
export function childSlotsListed(listed: string, key: string): string[] {
	const prefix = `pi-conversation-${key}@`;
	return listed
		.split("\n")
		.map((line) => line.trim().split(/\s+/)[0] ?? "")
		.filter((unit) => unit.startsWith(prefix) && unit.endsWith(".service"))
		.map((unit) => unit.slice(prefix.length, -".service".length))
		.filter((slot) => isSessionId(slot));
}

/**
 * The conversations host `key`'s running children run, by each slot's
 * file, which names what the host last held for its child: an open's
 * slot is a fresh id, and a child that became another conversation
 * runs that one. A slot whose file names none counts as its own name.
 */
export async function conversationsInChildren(
	folder: string,
	key: string,
	slots: readonly string[],
): Promise<Set<string>> {
	const running = new Set<string>();
	for (const name of slots) {
		const held = await slotHolds(slotOf(folder, key, name));
		running.add((held ?? name).toLowerCase());
	}
	return running;
}

/**
 * Each conversation of `sessions` with whether one of `running`, the
 * conversations this host's running children run, is it; ids compare
 * as the supervisor compares them, whatever their case.
 */
export function whereSessionsRun(
	sessions: readonly SessionIdentity[],
	running: ReadonlySet<string>,
): WhereItRuns[] {
	return sessions.map(({ sessionId, state, cwd }) => ({
		sessionId,
		state,
		cwd,
		own: running.has(sessionId.toLowerCase()),
	}));
}

/** `text` with control characters shown as `?`, so none reaches the terminal. */
function printable(text: string): string {
	return [...text]
		.map((char) => (controlCharacter(char.charCodeAt(0)) ? "?" : char))
		.join("");
}

const LAST_C0 = 0x1f;
const DELETE = 0x7f;
const LAST_C1 = 0x9f;

/** Whether a character's code is a C0 or C1 control, or delete. */
function controlCharacter(code: number): boolean {
	return code <= LAST_C0 || (code >= DELETE && code <= LAST_C1);
}

const WHERE_WIDTH = "host's thread ".length;
const STATE_WIDTH = "parked  ".length;

/** A host's count of conversations in their own process, then a line each. */
export function describeWhere(
	kind: string,
	rows: readonly WhereItRuns[],
): string[] {
	if (rows.length === 0) return [`${kind}: no conversations`];
	const own = rows.filter((row) => row.own).length;
	return [
		`${kind}: ${own} of ${rows.length} conversations run in a process of their own`,
		...rows.map(
			(row) =>
				`  ${(row.own ? "own process" : "host's thread").padEnd(WHERE_WIDTH)}${row.state.padEnd(STATE_WIDTH)}${row.sessionId}  ${printable(row.cwd)}`,
		),
	];
}

/**
 * The slots of host `key`'s child units systemd runs or is starting,
 * since one starting already holds its conversation.
 */
async function runningSlots(key: string): Promise<string[]> {
	const { stdout } = await promisify(execFile)(
		"systemctl",
		[
			"--user",
			"list-units",
			"--type=service",
			"--state=active,activating,reloading",
			"--plain",
			"--no-legend",
			`pi-conversation-${key}@*.service`,
		],
		{ timeout: SYSTEMCTL_WITHIN_MS },
	);
	return childSlotsListed(stdout, key);
}

/** Why `error` happened, printable. */
function why(error: unknown): string {
	return printable(error instanceof Error ? error.message : String(error));
}

/** The lines for one host, or why it couldn't be read. */
async function readHost(
	realm: string,
	kind: HostKind,
	runtimeDir: string,
): Promise<string[]> {
	const reply = await controlRequest(hostSocketPath(realm, kind, runtimeDir), {
		v: 1,
		id: randomUUID(),
		op: "list",
	});
	if (!reply.ok) throw new Error(`the host refused: ${reply.error.message}`);
	const { sessions } = parseListResult(reply.result);
	const key = hostKey(realm, kind);
	let slots: string[];
	try {
		slots = await runningSlots(key);
	} catch (error) {
		throw new Error(
			`${sessions.length} conversations listed, but systemd's units weren't: ${why(error)}`,
		);
	}
	const running = await conversationsInChildren(
		slotFolder(runtimeDir, key),
		key,
		slots,
	);
	return describeWhere(kind, whereSessionsRun(sessions, running));
}

if (import.meta.main) {
	const asked = process.argv.slice(2);
	const kinds: HostKind[] = asked.length > 0 ? [] : ["attended", "background"];
	for (const kind of asked) {
		if (kind !== "attended" && kind !== "background")
			throw new Error(
				"Usage: node scripts/where-sessions-run.ts [attended|background]...",
			);
		kinds.push(kind);
	}
	const realm = hostRealm(process.env);
	// The host's socket and its children's slots, from the one folder.
	const runtimeDir = loginRuntimeDir();
	if (!runtimeDir)
		throw new Error(
			"No runtime folder: neither AGENTS_RUNTIME_DIR nor XDG_RUNTIME_DIR is set, and on a Mac getconf named no cache folder",
		);
	let unread = false;
	for (const kind of kinds) {
		try {
			console.log((await readHost(realm, kind, runtimeDir)).join("\n"));
		} catch (error) {
			unread = true;
			console.log(`${kind}: not read: ${why(error)}`);
		}
	}
	process.exitCode = unread ? 1 : 0;
}
