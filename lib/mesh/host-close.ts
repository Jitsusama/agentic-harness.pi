/**
 * Closing one conversation that another process hosts, or releasing it
 * back to plain pi.
 *
 * A host holds several conversations under one pid, so ending one is
 * never a signal: it is a close sent to the host's control socket,
 * `$XDG_RUNTIME_DIR/pi-host/<realm>-<kind>.sock`, the realm and kind
 * read off the host key a presence names. The request carries the
 * host's full process identity as `expectedHost`, so a socket some
 * successor took over refuses it rather than closing a stranger's
 * conversation. Anything short of the host's own yes reads as unsure:
 * the client never retries, since a close may already have landed.
 * Every request says who asked, as `by`, for the line the host's
 * journal writes as it lets the conversation go.
 */

import { randomUUID } from "node:crypto";
import { hostSocketPath } from "../../host/service/address.ts";
import { controlRequest } from "../../host/service/client.ts";
import { parseSessionResult } from "../../host/service/protocol.ts";
import { hosted } from "../core/session/index.ts";
import type { TickedOwner } from "../internal/process-ticks.ts";

/** What a host said, or didn't, when asked to close one conversation. */
export type HostClose = "ended" | "unsure";

/** The longest `by` the host's protocol takes; a longer one is refused. */
const CALLER_MOST = 128;

/** The socket's two parts, from a host key `<realm>-<kind>`. */
const HOST_KEY = /^(.+)-(attended|background)$/;

/**
 * Whether this process's own host holds the conversation the owner
 * names, judged by its key and its whole process identity.
 */
export function hostedHere(owner: TickedOwner): boolean {
	const host = hosted();
	return (
		host !== undefined &&
		owner.session !== undefined &&
		host.key === owner.host &&
		host.owner.pid === owner.pid &&
		host.owner.startedAt === owner.startedAt &&
		host.owner.bootId === owner.bootId &&
		host.owner.startTicks === owner.startTicks
	);
}

/**
 * Ask the host the owner names to close only its conversation, through
 * the host's control socket under `runtimeDir`, saying `by` asked.
 */
export function closeThroughHost(
	owner: TickedOwner,
	by: string,
	runtimeDir = process.env.XDG_RUNTIME_DIR,
	timeoutMs?: number,
): Promise<HostClose> {
	return endThroughHost("close", owner, by, runtimeDir, timeoutMs);
}

/**
 * Ask the host the owner names to let only its conversation go back to
 * plain pi, as a release does, so its viewers are told it was released
 * rather than closed, saying `by` asked.
 */
export function releaseThroughHost(
	owner: TickedOwner,
	by: string,
	runtimeDir = process.env.XDG_RUNTIME_DIR,
	timeoutMs?: number,
): Promise<HostClose> {
	return endThroughHost("release", owner, by, runtimeDir, timeoutMs);
}

async function endThroughHost(
	op: "close" | "release",
	owner: TickedOwner,
	by: string,
	runtimeDir: string | undefined,
	timeoutMs: number | undefined,
): Promise<HostClose> {
	const key = owner.host === undefined ? undefined : HOST_KEY.exec(owner.host);
	if (!key || !owner.session) return "unsure";
	const [hostKey, realm, kind] = key;
	if (realm === undefined || (kind !== "attended" && kind !== "background"))
		return "unsure";
	try {
		const reply = await controlRequest(
			hostSocketPath(realm, kind, runtimeDir),
			{
				v: 1,
				id: `mesh-${op === "close" ? "end" : op}-${randomUUID()}`,
				op,
				sessionId: owner.session,
				by: by.slice(0, CALLER_MOST),
				expectedHost: { key: hostKey, owner: identityOf(owner) },
			},
			timeoutMs,
		);
		return reply.ok &&
			parseSessionResult(reply.result).sessionId === owner.session
			? "ended"
			: "unsure";
	} catch {
		// No socket, a refused request or a lost reply all leave the
		// outcome unknown, and an unknown close is never retried or
		// turned into a signal to the pid the host shares.
		return "unsure";
	}
}

function identityOf(owner: TickedOwner) {
	return {
		pid: owner.pid,
		startedAt: owner.startedAt,
		...(owner.bootId === undefined ? {} : { bootId: owner.bootId }),
		...(owner.startTicks === undefined ? {} : { startTicks: owner.startTicks }),
	};
}
