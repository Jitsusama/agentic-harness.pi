/**
 * Real-dependency wiring for the liveness snapshot.
 *
 * The pure snapshot builder in `lib/internal/quest/session-liveness`
 * takes its side effects as injected functions so it never shells
 * out under test. This module supplies the live ones: activity read
 * from the pi session store, the process floor probing local pids,
 * and terminal probing routed through each recorded driver's own
 * liveness capability under a bounded timeout. Call sites build one
 * snapshot per request and derive every session over it.
 */

import { sessionsDir } from "../../lib/internal/paths.js";
import {
	localProcessDeps,
	probeProcess,
} from "../../lib/internal/quest/process-liveness.js";
import {
	activityFromIndex,
	buildLivenessSnapshot,
	indexSessionFiles,
	type LivenessSnapshot,
} from "../../lib/internal/quest/session-liveness.js";
import type { QuestSession } from "../../lib/quest/index.js";
import {
	getLivenessProvider,
	type TerminalProbe,
	type TerminalSessionHandle,
	terminalHandleKey,
} from "../../lib/terminal/index.js";

/** How long to wait on one driver's batched terminal probe before giving up. */
const TERMINAL_PROBE_TIMEOUT_MS = 2000;

/**
 * Build a read-time liveness snapshot for a set of sessions using the
 * live process and terminal probes. Indexes the session store once,
 * so a caller deriving many sessions pays a single store walk.
 */
export function buildSessionSnapshot(
	sessions: readonly QuestSession[],
	opts: { now?: Date; conflicted?: ReadonlySet<string> } = {},
): Promise<LivenessSnapshot> {
	const index = indexSessionFiles(sessionsDir());
	const processDeps = localProcessDeps();
	return buildLivenessSnapshot(sessions, {
		now: opts.now,
		conflicted: opts.conflicted,
		activityOf: (id) => activityFromIndex(index, id),
		probeProcess: (id) => probeProcess(id, processDeps),
		probeTerminals: probeTerminalsByDriver,
	});
}

/**
 * The subset of pane values currently live in one terminal, probed
 * through the driver that issued the template handle. Builds a handle
 * per pane from the template (same driver, host and scope) and keeps
 * only those the probe reports present, so an unknown or absent pane
 * is never treated as live. Used by restore to exclude panes still on
 * screen.
 */
export async function probeLivePaneValues(
	template: TerminalSessionHandle,
	paneValues: readonly string[],
): Promise<Set<string>> {
	if (paneValues.length === 0) return new Set();
	const handles = paneValues.map((value) => ({ ...template, value }));
	const probes = await probeTerminalsByDriver(handles);
	const live = new Set<string>();
	for (const handle of handles) {
		if (probes.get(terminalHandleKey(handle)) === "present") {
			live.add(handle.value);
		}
	}
	return live;
}

/**
 * Probe terminal handles grouped by their recorded driver, routing
 * each group through that driver's liveness capability. A driver with
 * no capability, or one whose probe fails or times out, yields
 * unknown for its handles, never a false absent.
 */
async function probeTerminalsByDriver(
	handles: readonly TerminalSessionHandle[],
): Promise<ReadonlyMap<string, TerminalProbe>> {
	const byDriver = new Map<string, TerminalSessionHandle[]>();
	for (const handle of handles) {
		const group = byDriver.get(handle.driverId) ?? [];
		group.push(handle);
		byDriver.set(handle.driverId, group);
	}
	const merged = new Map<string, TerminalProbe>();
	for (const [driverId, group] of byDriver) {
		const provider = getLivenessProvider(driverId);
		if (!provider) {
			for (const handle of group) {
				merged.set(terminalHandleKey(handle), "unknown");
			}
			continue;
		}
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		// Race the probe against an independent timeout rather than only
		// aborting the signal: a driver that ignores its AbortSignal would
		// otherwise hang the whole snapshot. The timeout wins with a
		// sentinel and every handle in the group reads unknown.
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve("timeout");
			}, TERMINAL_PROBE_TIMEOUT_MS);
		});
		try {
			const result = await Promise.race([
				provider.probe(group, controller.signal),
				timeout,
			]);
			if (result === "timeout") {
				for (const handle of group) {
					merged.set(terminalHandleKey(handle), "unknown");
				}
			} else {
				for (const [key, probe] of result) merged.set(key, probe);
			}
		} catch {
			// Probe failed: unknown, not a false absent.
			for (const handle of group) {
				merged.set(terminalHandleKey(handle), "unknown");
			}
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	return merged;
}
