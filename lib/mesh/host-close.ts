/**
 * Closing one conversation that another process hosts.
 *
 * A host holds several conversations under one pid, so ending one is
 * never a signal: it is a close sent to the host's control socket,
 * `$XDG_RUNTIME_DIR/pi-host/<realm>-<kind>.sock`, the realm and kind
 * read off the host key a presence names. The request carries the
 * host's full process identity as `expectedHost`, so a socket some
 * successor took over refuses it rather than closing a stranger's
 * conversation. Anything short of the host's own yes reads as unsure:
 * the client never retries, since a close may already have landed.
 */

import { randomUUID } from "node:crypto";
import { hostSocketPath } from "../../host/service/address.ts";
import { controlRequest } from "../../host/service/client.ts";
import { hosted } from "../core/session/index.ts";
import type { TickedOwner } from "../internal/process-ticks.ts";

/** What a host said, or didn't, when asked to close one conversation. */
export type HostClose = "ended" | "unsure";

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
 * the host's control socket under `runtimeDir`.
 */
export async function closeThroughHost(
	owner: TickedOwner,
	runtimeDir = process.env.XDG_RUNTIME_DIR,
	timeoutMs?: number,
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
				id: `mesh-end-${randomUUID()}`,
				op: "close",
				sessionId: owner.session,
				expectedHost: { key: hostKey, owner: identityOf(owner) },
			},
			timeoutMs,
		);
		return reply.ok ? "ended" : "unsure";
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
