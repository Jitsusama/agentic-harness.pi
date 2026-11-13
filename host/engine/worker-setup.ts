/**
 * Spike (worker per awake engine), never merged: what the main thread
 * hands a conversation's worker as it starts, and what a worker says it
 * weighs. Plain data both ways, since it crosses threads by structured
 * clone.
 */
import type { SessionOwner } from "../../lib/core/session/index.ts";

/** What a worker is started with. */
export interface WorkerSetup {
	readonly packageDir: string;
	/** The engine's state folder, the same as the main thread's, so wake files agree. */
	readonly stateDir: string;
	/** Where the theme's settings are read from. */
	readonly home: string;
	readonly key: string;
	readonly owner: SessionOwner;
	/** The realm's environment every conversation starts from. */
	readonly env: Record<string, string>;
	/** Whether the gateway key was inherited; none leaves requests without one. */
	readonly keyInherited?: boolean;
	/** Take a conversation's launch from its request, as the host program does. */
	readonly launchFromRequest: boolean;
	readonly collectWhenQuiet?: boolean;
	/** A module the worker imports once pi is loaded, such as a fixture's provider. */
	readonly setup?: string;
	/** How the host's other conversations stand, as the worker starts. */
	readonly mirror: readonly (readonly [string, "busy" | "idle" | "parked"])[];
}

/** What one worker weighs, its own collection done first. */
export interface WorkerWeight {
	readonly threadId: number;
	readonly ids: readonly string[];
	readonly heapKb: number;
	readonly heapTotalKb: number;
	readonly externalKb: number;
	readonly arrayBuffersKb: number;
	readonly loopP99Ms: number;
	readonly loopMaxMs: number;
	readonly loopBusy: number;
	readonly sessions: readonly string[];
}
