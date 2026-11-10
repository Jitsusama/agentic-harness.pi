/**
 * Where a hosted conversation's model auth looks for keys: the
 * conversation's own environment, as each request would send it, never
 * the host process's. pi reads a configured `$VAR` key, checks a
 * provider is set up before a prompt, and lists available models through
 * this, so a host holding no key of its own still runs conversations
 * that each hold theirs.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";

/** pi-ai's auth context: how auth reads variables and checks files. */
export interface AuthContext {
	env(name: string): Promise<string | undefined>;
	fileExists(path: string): Promise<boolean>;
}

/**
 * An auth context over a conversation's environment. A blank value reads
 * as unset, as pi's own does; a path starting `~` is under the
 * conversation's HOME.
 */
export function conversationAuthContext(
	env: () => Promise<Readonly<Record<string, string>>>,
): AuthContext {
	return {
		async env(name) {
			const value = (await env())[name];
			return value !== undefined && value.trim().length > 0 ? value : undefined;
		},
		async fileExists(path) {
			const home = (await env()).HOME;
			if (path.startsWith("~") && home === undefined) return false;
			const resolved =
				path.startsWith("~") && home !== undefined
					? join(home, path.slice(1))
					: path;
			return access(resolved).then(
				() => true,
				() => false,
			);
		},
	};
}
