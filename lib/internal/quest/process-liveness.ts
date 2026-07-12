/**
 * The process-liveness floor: classify a recorded pi process by
 * whether it is still running, using an OS-derived start token to
 * survive pid reuse. This is the terminal-agnostic layer under the
 * terminal-driver liveness capability; a session with no terminal
 * identity still gets an honest answer from its process alone.
 *
 * The OS inspection is injected so the branching logic stays pure
 * and testable; the platform readers live in the caller.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/** Stable identity of a recorded pi process. */
export interface ProcessIdentity {
	/** Host the process was observed on; a remote host is unprobeable. */
	hostId: string;
	/** OS process id. */
	pid: number;
	/**
	 * OS-derived process-start token (creation time or equivalent).
	 * Distinguishes the original process from a later pid reuse.
	 */
	startToken: string;
}

/** What an OS inspection of a pid found. */
export type ProcessInspection =
	| { kind: "alive"; startToken: string }
	| { kind: "gone" }
	| { kind: "unknown" };

/** The floor's verdict for one recorded process. */
export type ProcessProbe = "matching" | "gone" | "unknown";

/** Dependencies for {@link probeProcess}: the local host and the OS reader. */
export interface ProbeProcessDeps {
	/** The reader's own host id, compared against the recorded host. */
	localHostId: string;
	/** Inspect a live pid on the local host. */
	inspect: (pid: number) => ProcessInspection;
}

/**
 * Classify a recorded process. A recorded host that is not the local
 * host is unknown (we cannot see it). Otherwise the OS inspection
 * decides: no such pid is gone, a pid held by a process with a
 * different start token is gone (reuse), a matching token is
 * matching, and anything the inspection could not determine is
 * unknown.
 */
/**
 * Read a live pid's OS start token. Uses `ps -o lstart=`, present on
 * macOS and Linux, which yields a stable per-process start timestamp
 * that distinguishes a pid from a later reuse. A pid no process holds
 * is gone; a missing `ps` or any other failure is unknown, so an
 * inability to probe never reads as death.
 */
function readStartToken(pid: number): ProcessInspection {
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
		}).trim();
		return out.length > 0
			? { kind: "alive", startToken: out }
			: { kind: "gone" };
	} catch (error) {
		// `ps` exits non-zero when no process holds the pid: that is
		// gone. A spawn failure (ps absent, unsupported platform) is
		// unknown, never death.
		if (isExitStatusError(error)) return { kind: "gone" };
		return { kind: "unknown" };
	}
}

/** Whether an execFile error is a clean non-zero exit, not a spawn failure. */
function isExitStatusError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"status" in error &&
		typeof (error as { status: unknown }).status === "number"
	);
}

/** A lifetime-stable synthetic token for when the OS reader cannot help. */
const FALLBACK_START_TOKEN = `pi-${process.pid}-${Date.now()}`;

/**
 * Identity of the currently running pi process, for capture onto the
 * session it is attached to. The start token comes from the OS reader
 * when available, falling back to a lifetime-stable synthetic so the
 * field is never empty.
 */
export function currentProcessIdentity(): ProcessIdentity {
	const found = readStartToken(process.pid);
	const startToken =
		found.kind === "alive" ? found.startToken : FALLBACK_START_TOKEN;
	return { hostId: hostname(), pid: process.pid, startToken };
}

/** The always-on local floor: this host plus the OS start-token reader. */
export function localProcessDeps(): ProbeProcessDeps {
	return { localHostId: hostname(), inspect: readStartToken };
}

/** Id minted once per pi process, identifying which process holds a session lease. */
const INSTANCE_ID = randomUUID();

/**
 * The current pi process's instance id, stable for the life of the
 * process. Stored on a session at attach so a later shutdown detaches
 * only when the same instance still owns it.
 */
export function currentInstanceId(): string {
	return INSTANCE_ID;
}

export function probeProcess(
	id: ProcessIdentity,
	deps: ProbeProcessDeps,
): ProcessProbe {
	if (id.hostId !== deps.localHostId) return "unknown";
	const found = deps.inspect(id.pid);
	switch (found.kind) {
		case "gone":
			return "gone";
		case "unknown":
			return "unknown";
		case "alive":
			return found.startToken === id.startToken ? "matching" : "gone";
	}
}
