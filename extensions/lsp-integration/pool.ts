/**
 * pi's own language servers as a conversation's other extensions reach
 * them.
 *
 * The pool starts each server in the fence a call hands it, and starts
 * one as it is for a call that hands none. Verification's diagnostics
 * and any other extension resolve the pool through the registry and
 * name no fence, so a fenced session's pool is registered with its
 * fence drawn into every call: no caller can leave it out.
 */
import type {
	LspBackend,
	LspCallOptions,
	LspFence,
	StandaloneBackend,
} from "../../lib/core/lsp/index.ts";

/**
 * Said to a fenced call when the host's servers are an older pi's:
 * those servers start outside any fence, so a fenced session asks
 * none. The pool is shared by the host's conversations and replaced
 * only once none holds it, which a reload never brings about, since a
 * reloaded runner takes it up before the old one lets it go. A server
 * dying under a call from an unfenced session that runs this pi
 * replaces it sooner, since that call's retry starts a pool that
 * fences; an older runner's retry starts another that doesn't.
 */
export const UNFENCED_POOL =
	"This host's language servers were started by an older pi that runs them outside the fence, so a fenced session asks none until they are replaced, which may not be before the host next starts.";

/**
 * Whether `backend` is a pool that runs servers in a fence: one an
 * older pi made, shared by the host's conversations through a reload,
 * has no `stopFence` or `dropFence`, and starts every server as it is.
 */
export function fences(backend: object): backend is StandaloneBackend {
	const pool = backend as Partial<StandaloneBackend>;
	return (
		typeof pool.stopFence === "function" && typeof pool.dropFence === "function"
	);
}

/**
 * `pool` as a session's other extensions reach it: as it is where the
 * session's commands run as they are, and otherwise with `fence` handed
 * to each call that names none. An older pi's pool, which can't run a
 * server in a fence, is asked nothing, and each call says why.
 */
export function fencedPool(
	pool: StandaloneBackend,
	fence: LspFence | undefined,
): LspBackend {
	if (!fence) return pool;
	const fenced = (options?: LspCallOptions): LspCallOptions => {
		if (!fences(pool)) throw new Error(UNFENCED_POOL);
		return { ...options, fence: options?.fence ?? fence };
	};
	return {
		name: pool.name,
		diagnostics: async (path, options) =>
			pool.diagnostics(path, fenced(options)),
		definition: async (target, options) =>
			pool.definition(target, fenced(options)),
		references: async (target, options) =>
			pool.references(target, fenced(options)),
		hover: async (target, options) => pool.hover(target, fenced(options)),
		documentSymbols: async (path, options) =>
			pool.documentSymbols(path, fenced(options)),
		workspaceSymbols: async (query, options) =>
			pool.workspaceSymbols(query, fenced(options)),
		rename: async (target, newName, options) =>
			pool.rename(target, newName, fenced(options)),
		codeActions: async (path, range, options) =>
			pool.codeActions(path, range, fenced(options)),
		// The pool is the host's, shared by its conversations: one
		// extension's dispose can't take it from the others. The lease
		// disposes it as its last user goes.
		dispose: async () => {},
	};
}
