/** Standalone LSP lifetime shared by the runners in one process. */
import {
	createStandaloneBackend,
	type LspBackend,
	registerLspBackend,
	type StandaloneBackend,
	unregisterLspBackend,
} from "../../lsp/index.ts";

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
	registerLspBackend({
		name: "standalone",
		priority: 100,
		isAvailable: () => true,
		backend,
	});
	return backend;
}

/** A runner's claim on the shared standalone servers, acquired lazily. */
export function standaloneLease() {
	const user = Symbol("lsp runner");
	return {
		ensure(): StandaloneBackend {
			const state = shared();
			state.users.add(user);
			return state.backend ?? start(state);
		},
		current(): StandaloneBackend | null {
			return shared().backend;
		},
		async restart(dead: LspBackend): Promise<StandaloneBackend> {
			const state = shared();
			// Another caller may already have replaced this dead backend.
			if (state.backend !== dead) return this.ensure();
			const fresh = start(state);
			await dead.dispose().catch(() => {
				// A closed connection may reject shutdown; disposal kills its processes.
			});
			return fresh;
		},
		async release(): Promise<void> {
			const state = shared();
			if (!state.users.delete(user) || state.users.size > 0) return;
			const closing = state.backend;
			state.backend = null;
			unregisterLspBackend("standalone");
			await closing?.dispose();
		},
	};
}
