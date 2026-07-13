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
		const stdout = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
		});
		return interpretPsLookup({
			spawned: true,
			exitStatus: 0,
			stdout,
			stderr: "",
		});
	} catch (error) {
		return interpretPsLookup(psLookupFromError(error));
	}
}

/** Read the observable facts of a failed `ps` run off the thrown error. */
function psLookupFromError(error: unknown): {
	spawned: boolean;
	exitStatus: number | null;
	stdout: string;
	stderr: string;
} {
	const e = (error ?? {}) as {
		status?: unknown;
		stdout?: unknown;
		stderr?: unknown;
	};
	const exitStatus = typeof e.status === "number" ? e.status : null;
	return {
		// A numeric exit status means `ps` ran; no status means it never
		// spawned (absent binary, unsupported platform).
		spawned: exitStatus !== null,
		exitStatus,
		stdout: typeof e.stdout === "string" ? e.stdout : "",
		stderr: typeof e.stderr === "string" ? e.stderr : "",
	};
}

/**
 * Map the observable facts of a `ps -o lstart=` lookup to an
 * inspection. Only a clean non-zero exit that printed no diagnostic
 * is `gone` (the pid holds no process); a diagnostic on stderr means
 * `ps` rejected the query (an unsupported option on a minimal `ps`),
 * and a lookup that never spawned is `unknown`, so an inability to
 * probe is never read as death.
 */
export function interpretPsLookup(r: {
	spawned: boolean;
	exitStatus: number | null;
	stdout: string;
	stderr: string;
}): ProcessInspection {
	if (!r.spawned) return { kind: "unknown" };
	if (r.exitStatus === 0) {
		const token = r.stdout.trim();
		// A live pid always prints its start line on a zero exit. An
		// empty zero-exit is anomalous, not a clean "no such pid" (that
		// comes via a non-zero exit), so treat it as unknown rather than
		// declaring death.
		return token.length > 0
			? { kind: "alive", startToken: token }
			: { kind: "unknown" };
	}
	// A non-zero exit is only "no such pid" when ps said nothing at
	// all; any diagnostic, on either stream, means it could not answer
	// the query, which is unknown rather than death.
	const quiet = r.stdout.trim().length === 0 && r.stderr.trim().length === 0;
	return quiet ? { kind: "gone" } : { kind: "unknown" };
}

/**
 * Build a probeable process identity from a live inspection, or none
 * when the start token could not be read. Recording an identity with
 * a synthetic token would guarantee a later mismatch against a real
 * ps reading and read the session dead, so an unreadable capture is
 * left without a process identity and falls back to recency instead.
 */
export function identityFromInspection(
	hostId: string,
	pid: number,
	inspection: ProcessInspection,
): ProcessIdentity | undefined {
	return inspection.kind === "alive"
		? { hostId, pid, startToken: inspection.startToken }
		: undefined;
}

/**
 * Identity of the currently running pi process, for capture onto the
 * session it is attached to. Undefined when the OS reader could not
 * read a real start token: a session then carries no process identity
 * and its liveness falls back to recency, rather than a synthetic
 * token that a later probe would read as a dead mismatch.
 */
export function currentProcessIdentity(): ProcessIdentity | undefined {
	return identityFromInspection(
		hostname(),
		process.pid,
		readStartToken(process.pid),
	);
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
