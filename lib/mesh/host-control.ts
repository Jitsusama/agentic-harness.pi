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
 */

import { loadOnce } from "../internal/process/single-flight.ts";

type Client = typeof import("../../host/service/client.ts");

const client = loadOnce(() => import("../../host/service/client.ts"));

/** The host's protocol, loaded on first use, to read what a reply carries. */
export const hostProtocol = loadOnce(
	() => import("../../host/service/protocol.ts"),
);

/**
 * Send one control request to the host at `path` and read its reply,
 * as the host's own client does, loading that client on first use.
 */
export async function controlRequest(
	...request: Parameters<Client["controlRequest"]>
): ReturnType<Client["controlRequest"]> {
	return (await client()).controlRequest(...request);
}
