/** Stable realm-kind sockets, independent of a host process's restart identity. */
import { isAbsolute, join } from "node:path";

const MAX_SOCKET_PATH_BYTES = 103;
const MAX_REALM_LENGTH = 64;
// The same rule lib/internal/realm.ts holds a realm name to.
const REALM_NAME = /^[a-z0-9-]+$/;

/** A host's kind: an attended screen or background work. */
export type HostKind = "attended" | "background";

function validRealm(realm: string): boolean {
	return REALM_NAME.test(realm) && realm.length <= MAX_REALM_LENGTH;
}

/**
 * The realm a host serves, from a session's environment snapshot:
 * MYCELIUM_REALM, else the machine's home realm PI_HOME_REALM. Neither
 * set, or a name no folder may carry, refuses rather than guessing.
 */
export function hostRealm(
	env: Readonly<Record<string, string | undefined>>,
): string {
	const realm = env.MYCELIUM_REALM?.trim() || env.PI_HOME_REALM?.trim();
	if (!realm) throw new Error("Host needs MYCELIUM_REALM or PI_HOME_REALM");
	if (!validRealm(realm))
		throw new Error("Host realm must be a short lowercase name");
	return realm;
}

/** The stable key a realm-kind host goes by in its roster and registry. */
export function hostKey(realm: string, kind: HostKind): string {
	if (!validRealm(realm))
		throw new Error("Host realm must be a short lowercase name");
	if (kind !== "attended" && kind !== "background")
		throw new Error("Host kind must be attended or background");
	return `${realm}-${kind}`;
}

/** Select a local socket without accepting path separators or truncating Unix addresses. */
export function hostSocketPath(
	realm: string,
	kind: HostKind,
	runtimeDir = process.env.XDG_RUNTIME_DIR,
): string {
	const key = hostKey(realm, kind);
	if (!runtimeDir || !isAbsolute(runtimeDir))
		throw new Error("Host requires an absolute XDG_RUNTIME_DIR");
	const path = join(runtimeDir, "pi-host", `${key}.sock`);
	if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES)
		throw new Error("Host socket path exceeds the portable Unix socket limit");
	return path;
}
