/**
 * Every panel that is up, or waiting to be, so a session's end can
 * close them all.
 *
 * Pi ends a session (`/new`, `/resume`, `/fork`, `/reload`, quit) by
 * hiding the topmost overlay. It neither settles the panel's promise nor
 * disposes it, and a panel raised outside a turn has no turn signal to
 * close on. Left alone, such a panel answered nothing and kept the gate
 * queue, which is process-global and outlives a reload, so every later
 * panel in every later session waited behind it. A panel still queued
 * would mount in the next session instead, asking about a conversation
 * nobody could see any more.
 *
 * So each panel records a way to stop it from the moment it is asked
 * for, and `closeEveryPanel` stops them all; a `session_shutdown`
 * handler calls it. A stopped panel answers the way Escape would, the
 * same as a turn being stopped, so a gate fails closed.
 *
 * Kept on a process-global key for the queue's reason: two packages that
 * each carry a `lib/ui` still share one screen, and one handler must
 * reach both copies' panels. The first copy to load installs it; every
 * later one joins what it finds, whatever version installed it.
 */

const REGISTRY_KEY = Symbol.for("agentic-harness.open-panels");

/** The protocol version this copy installs. */
const PROTOCOL_VERSION = 1;

/**
 * What every copy agrees on. A later version may add to it but must keep
 * these, since an older copy calls them.
 */
interface PanelRegistryProtocol {
	readonly version: number;
	/** Record a panel's stop, returning the call that forgets it. */
	track(stop: () => void): () => void;
	/** Stop every panel recorded, returning how many there were. */
	closeAll(): number;
}

/**
 * Record a panel from the moment it is asked for, returning the call
 * that forgets it once it has answered.
 */
export function trackPanel(stop: () => void): () => void {
	return sharedRegistry().track(stop);
}

/**
 * Stop every panel that is up or waiting, in every copy of this library,
 * returning how many there were. Each answers as Escape would.
 */
export function closeEveryPanel(): number {
	return sharedRegistry().closeAll();
}

function sharedRegistry(): PanelRegistryProtocol {
	const g = globalThis as Record<symbol, unknown>;
	const found = g[REGISTRY_KEY];
	if (isProtocol(found)) return found;
	const installed = createRegistry();
	g[REGISTRY_KEY] = installed;
	return installed;
}

function isProtocol(value: unknown): value is PanelRegistryProtocol {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		version?: unknown;
		track?: unknown;
		closeAll?: unknown;
	};
	return (
		typeof candidate.version === "number" &&
		candidate.version >= 1 &&
		typeof candidate.track === "function" &&
		typeof candidate.closeAll === "function"
	);
}

function createRegistry(): PanelRegistryProtocol {
	const stops = new Set<() => void>();
	return {
		version: PROTOCOL_VERSION,
		track(stop) {
			// Wrapped, so the same function tracked twice is two panels.
			const entry = () => stop();
			stops.add(entry);
			return () => {
				stops.delete(entry);
			};
		},
		closeAll() {
			const now = [...stops];
			stops.clear();
			for (const stop of now) {
				try {
					stop();
				} catch {
					// One panel failing to stop must not keep the rest up; a
					// stop only aborts a signal, so this is not expected.
				}
			}
			return now.length;
		},
	};
}
