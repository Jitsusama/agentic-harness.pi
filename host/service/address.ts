/** Stable realm-kind sockets, independent of a host process's restart identity. */
import { isAbsolute, join } from "node:path";
import { runtimeDir as loginRuntimeDir } from "../../lib/internal/paths.ts";

/** What a host says when it has no runtime folder to listen in. */
const NO_RUNTIME_FOLDER =
	"Host requires an absolute runtime folder: AGENTS_RUNTIME_DIR, XDG_RUNTIME_DIR, or a Mac's cache folder";

/** The longest socket path every Unix this runs on binds whole. */
export const MAX_SOCKET_PATH_BYTES = 103;
const MAX_REALM_LENGTH = 64;
// The same rule lib/internal/machine/realm.ts holds a realm name to.
const REALM_NAME = /^[a-z0-9-]+$/;

/**
 * The command line a child host is started with: one conversation in a
 * process of its own, which its host's supervisor starts (child.ts).
 */
export const CHILD_FLAG = "--child";

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

/** The realm and kind a host key names, refusing one hostKey wouldn't make. */
export function hostKeyParts(key: string): { realm: string; kind: HostKind } {
	const parts = /^(.+)-(attended|background)$/.exec(key);
	const [, realm, kind] = parts ?? [];
	if (!(realm && (kind === "attended" || kind === "background")))
		throw new Error(
			`${key} isn't a host key, realm-attended or realm-background`,
		);
	hostKey(realm, kind);
	return { realm, kind };
}

/** The folder a realm-kind host's children listen in, beside its own socket. */
export function childFolder(
	key: string,
	runtimeDir = loginRuntimeDir(),
): string {
	hostKeyParts(key);
	if (!runtimeDir || !isAbsolute(runtimeDir))
		throw new Error(NO_RUNTIME_FOLDER);
	return join(runtimeDir, "pi-host", `${key}.d`);
}

/** Whether a socket path fits a Unix address whole. */
export function socketFits(path: string): boolean {
	return Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES;
}

/** Select a local socket without accepting path separators or truncating Unix addresses. */
export function hostSocketPath(
	realm: string,
	kind: HostKind,
	runtimeDir = loginRuntimeDir(),
): string {
	const key = hostKey(realm, kind);
	if (!runtimeDir || !isAbsolute(runtimeDir))
		throw new Error(NO_RUNTIME_FOLDER);
	const path = join(runtimeDir, "pi-host", `${key}.sock`);
	if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES)
		throw new Error("Host socket path exceeds the portable Unix socket limit");
	return path;
}
