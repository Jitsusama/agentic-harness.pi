/** Standalone LSP lifetime shared by the runners in one process. */
import {
	createStandaloneBackend,
	type LspBackend,
	registerLspBackend,
	type StandaloneBackend,
	unregisterLspBackend,
} from "../../lsp/index.ts";
import { hosted, type SessionRef } from "../../session/index.ts";

interface SharedBackend {
	backend: StandaloneBackend | null;
	users: Set<symbol>;
}
const KEY = Symbol.for("pi:agentic-harness:standalone-lsp");

function shared(): SharedBackend {
	const host = globalThis as Record<symbol, SharedBackend | undefined>;
	const existing = host[KEY];
	if (existing) return existing;
	const fresh: SharedBackend = { backend: null, users: new Set() };
	host[KEY] = fresh;
	return fresh;
}

function start(state: SharedBackend): StandaloneBackend {
	const backend = createStandaloneBackend();
	state.backend = backend;
	return backend;
}

/**
 * What a runner hands the other extensions in its conversation in place
 * of the shared pool, read afresh at each lookup: the pool with the
 * conversation's fence drawn into every call, say, so a caller that
 * names no fence can't start a server outside it.
 */
export type RegisteredPool = (pool: StandaloneBackend) => LspBackend;

function registerFor(
	state: SharedBackend,
	ref?: SessionRef,
	registered?: RegisteredPool,
): void {
	registerLspBackend(
		{
			name: "standalone",
			priority: 100,
			isAvailable: () => state.backend !== null,
			// Other conversations see a replacement without holding the old object.
			get backend() {
				const pool = state.backend ?? start(state);
				return registered ? registered(pool) : pool;
			},
		},
		ref,
	);
}

/**
 * A runner's claim on the shared standalone servers, acquired lazily,
 * registered for its conversation as `registered` wraps them.
 */
export function standaloneLease(registered?: RegisteredPool) {
	const user = Symbol("lsp runner");
	return {
		ensure(ref?: SessionRef): StandaloneBackend {
			const state = shared();
			// Validate ownership before acquiring any shared resources.
			registerFor(state, ref, registered);
			state.users.add(user);
			return state.backend ?? start(state);
		},
		current(): StandaloneBackend | null {
			return shared().backend;
		},
		async restart(
			dead: LspBackend,
			ref?: SessionRef,
		): Promise<StandaloneBackend> {
			const state = shared();
			// Another caller may already have replaced this dead backend.
			if (state.backend !== dead) return this.ensure(ref);
			registerFor(state, ref, registered);
			const fresh = start(state);
			await dead.dispose().catch(() => {
				// A closed connection may reject shutdown; disposal kills its processes.
			});
			return fresh;
		},
		async release(ref?: SessionRef): Promise<void> {
			const state = shared();
			if (!state.users.has(user)) return;
			if (hosted()) unregisterLspBackend("standalone", ref);
			state.users.delete(user);
			if (state.users.size > 0) return;
			const closing = state.backend;
			state.backend = null;
			if (!hosted()) unregisterLspBackend("standalone", ref);
			await closing?.dispose();
		},
	};
}
