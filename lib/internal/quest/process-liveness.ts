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
import { readFileSync } from "node:fs";
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
	/**
	 * Identifier of the boot the process was recorded under. A reboot
	 * invalidates every pid on the host at once, so a record from an
	 * earlier boot is dead whatever the pid now holds. Optional: a
	 * record written before this was captured, or on a host with no
	 * readable token, falls through to the pid inspection.
	 */
	bootToken?: string;
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
	/**
	 * The boot the reader is running under. Optional, because a host
	 * with no readable token must not declare anything dead.
	 */
	localBootToken?: string;
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
	const identity = identityFromInspection(
		hostname(),
		process.pid,
		readStartToken(process.pid),
	);
	if (!identity) return undefined;
	// Stamp the boot alongside the pid, so a later reader can retire
	// this record wholesale after a reboot instead of asking the OS
	// about a pid that means nothing any more.
	const bootToken = currentBootToken();
	return bootToken ? { ...identity, bootToken } : identity;
}

/**
 * Whether the record is known to come from a different boot than the
 * reader's. Both tokens have to be present to say so: a record
 * written before boot tokens were captured, or a host with no
 * readable token, is not evidence of death.
 */
function fromAnotherBoot(id: ProcessIdentity, deps: ProbeProcessDeps): boolean {
	return (
		id.bootToken !== undefined &&
		deps.localBootToken !== undefined &&
		id.bootToken !== deps.localBootToken
	);
}

/**
 * Where Linux publishes a random identifier regenerated on each boot.
 */
const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/**
 * Read an identifier for the running boot, or undefined when the host
 * offers none.
 *
 * Both platforms expose a uuid minted at boot rather than a
 * timestamp: Linux in procfs, macOS as `kern.bootsessionuuid`. The
 * neighbouring `kern.boottime` looks like the obvious source and is
 * not one, because it is derived from the clock and shifts when NTP
 * adjusts it. A token that drifts mid-boot would read every live
 * session as dead, which is the one answer this module must never
 * invent.
 */
function readBootToken(): string | undefined {
	if (process.platform === "linux") {
		try {
			return nonEmpty(readFileSync(LINUX_BOOT_ID_PATH, "utf8"));
		} catch {
			// No procfs (a container, an unusual mount): no token, so the
			// probe falls through to inspecting the pid.
			return undefined;
		}
	}
	try {
		return nonEmpty(
			execFileSync("sysctl", ["-n", "kern.bootsessionuuid"], {
				encoding: "utf8",
			}),
		);
	} catch {
		// No sysctl, or the key is absent on this platform: same again,
		// no token rather than a guess.
		return undefined;
	}
}

/** Trim a reading, treating blank output as no reading at all. */
function nonEmpty(raw: string): string | undefined {
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Memoized boot token; a boot identifier cannot change under us. */
let bootTokenCache: { token: string | undefined } | undefined;

/**
 * The identifier of the boot this process is running under, read once
 * and remembered. Undefined on a host that publishes none, in which
 * case no session is ever judged by boot.
 */
export function currentBootToken(): string | undefined {
	bootTokenCache ??= { token: readBootToken() };
	return bootTokenCache.token;
}

/** The always-on local floor: this host plus the OS start-token reader. */
export function localProcessDeps(): ProbeProcessDeps {
	const localBootToken = currentBootToken();
	return {
		localHostId: hostname(),
		inspect: readStartToken,
		...(localBootToken ? { localBootToken } : {}),
	};
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
	// A pid outlives nothing across a reboot, so a record from an
	// earlier boot is dead without asking the OS: whatever holds that
	// pid now is a reuse, even when its start token happens to match.
	if (fromAnotherBoot(id, deps)) return "gone";
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
