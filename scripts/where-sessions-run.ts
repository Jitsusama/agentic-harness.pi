/**
 * Where each conversation a host runs is running: in a process of its
 * own, a child whose systemd unit runs, or on the host's own thread,
 * where one stalled conversation stalls every other. It is the live
 * measure of moving conversations off the host's thread, read from the
 * host's list and systemd, changing nothing. Node runs it as it
 * stands, stripping the types:
 *
 *   node scripts/where-sessions-run.ts [attended|background]...
 *
 * Without a kind it reads both hosts. A host that doesn't answer is
 * said and the next is read; exits 1 when any didn't, 0 otherwise.
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
import { slotOf } from "../host/service/child-units.ts";
import { controlRequest } from "../host/service/client.ts";
import {
	parseListResult,
	type SessionIdentity,
} from "../host/service/protocol.ts";

/** One conversation a host listed, and whether it has a process of its own. */
export interface WhereItRuns {
	readonly sessionId: string;
	readonly state: SessionIdentity["state"];
	readonly cwd: string;
	/** Its child's unit runs, so it runs off the host's thread. */
	readonly own: boolean;
}

/**
 * Each conversation of `sessions` with whether host `key`'s child unit
 * for it is among the running `units`; another host's unit of the same
 * conversation is not this host's child.
 */
export function whereSessionsRun(
	sessions: readonly SessionIdentity[],
	units: readonly string[],
	key: string,
): WhereItRuns[] {
	const running = new Set(units);
	return sessions.map(({ sessionId, state, cwd }) => ({
		sessionId,
		state,
		cwd,
		// The slot's own naming, so this reads the unit a host starts.
		own: running.has(slotOf("/", key, sessionId).unit),
	}));
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
				`  ${(row.own ? "own process" : "host's thread").padEnd(WHERE_WIDTH)}${row.state.padEnd(STATE_WIDTH)}${row.sessionId}  ${row.cwd}`,
		),
	];
}

/** The child units of host `key` that systemd says are running. */
async function runningUnits(key: string): Promise<string[]> {
	const { stdout } = await promisify(execFile)("systemctl", [
		"--user",
		"list-units",
		"--type=service",
		"--state=active",
		"--plain",
		"--no-legend",
		`pi-conversation-${key}@*.service`,
	]);
	return stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/)[0] ?? "")
		.filter((unit) => unit !== "");
}

/** The lines for one host, or why it couldn't be read. */
async function readHost(realm: string, kind: HostKind): Promise<string[]> {
	const reply = await controlRequest(hostSocketPath(realm, kind), {
		v: 1,
		id: randomUUID(),
		op: "list",
	});
	if (!reply.ok) throw new Error(reply.error.message);
	const { sessions } = parseListResult(reply.result);
	const key = hostKey(realm, kind);
	return describeWhere(
		kind,
		whereSessionsRun(sessions, await runningUnits(key), key),
	);
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
	let unread = false;
	for (const kind of kinds) {
		try {
			console.log((await readHost(realm, kind)).join("\n"));
		} catch (error) {
			unread = true;
			console.log(
				`${kind}: not read: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	process.exitCode = unread ? 1 : 0;
}
