/**
 * A host's control socket, for a pi that talks to a host now and then.
 *
 * The host's client checks every request and reply against the host's
 * protocol, which is written in zod. Loaded at start, zod held 2.1 MB
 * of heap and 9 MB resident in every pi (21 November, node 22), while a
 * pi outside a host only reaches a host's socket to open, adopt, list,
 * close or release a conversation there. So the client and protocol
 * load the first time one of those asks, and every later ask reuses
 * them. A host loads them anyway, for its own side of the socket.
 *
 * A client that fails to load has sent nothing, which no socket error
 * can say, so it fails as `HostClientUnloaded`: a caller that would read
 * an unknown error as "a host is there" or "it may have landed" can
 * tell it apart and refuse instead.
 */

import { loadOnce } from "../internal/process/single-flight.ts";

type Client = typeof import("../../host/service/client.ts");

const client = loadOnce(() => import("../../host/service/client.ts"));

/** The host's protocol, loaded on first use, to read what a reply carries. */
export const hostProtocol = loadOnce(
	() => import("../../host/service/protocol.ts"),
);

/** The host's client didn't load, so nothing was sent to any host. */
export class HostClientUnloaded extends Error {
	constructor(cause: unknown) {
		const why = cause instanceof Error ? cause.message : String(cause);
		super(`the host's client didn't load (${why})`, { cause });
		this.name = "HostClientUnloaded";
	}
}

/**
 * Send one control request to the host at `path` and read its reply,
 * as the host's own client does, loading that client on first use.
 */
export async function controlRequest(
	...request: Parameters<Client["controlRequest"]>
): ReturnType<Client["controlRequest"]> {
	let loaded: Client;
	try {
		loaded = await client();
	} catch (error) {
		throw new HostClientUnloaded(error);
	}
	return loaded.controlRequest(...request);
}
