/** Stable realm-kind sockets, independent of a host process's restart identity. */
import { isAbsolute, join } from "node:path";

const MAX_SOCKET_PATH_BYTES = 103;

/** Select a local socket without accepting path separators or truncating Unix addresses. */
export function hostSocketPath(
	realm: string,
	kind: "attended" | "background",
	runtimeDir = process.env.XDG_RUNTIME_DIR,
): string {
	if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(realm) || realm.length > 64)
		throw new Error("Host realm must be a short lowercase name");
	if (kind !== "attended" && kind !== "background")
		throw new Error("Host kind must be attended or background");
	if (!runtimeDir || !isAbsolute(runtimeDir))
		throw new Error("Host requires an absolute XDG_RUNTIME_DIR");
	const path = join(runtimeDir, "pi-host", `${realm}-${kind}.sock`);
	if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES)
		throw new Error("Host socket path exceeds the portable Unix socket limit");
	return path;
}
