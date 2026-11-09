/** Read a host's open sessions only after its process identity was checked. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../../internal/paths.ts";
import type { Standing, TickedOwner } from "../../internal/process-ticks.ts";
import { type HostRegistry, hosted } from "./host.ts";

/** The machine-wide host list; no session or realm changes this path. */
export function hostRegistryPath(
	owner: TickedOwner,
	dir = stateDir("hosts"),
): string {
	const start =
		owner.startTicks === undefined ? owner.startedAt : owner.startTicks;
	return join(dir, `${owner.pid}-${start}.json`);
}

function sameOwner(a: TickedOwner, b: TickedOwner): boolean {
	return (
		a.pid === b.pid &&
		a.startedAt === b.startedAt &&
		a.bootId === b.bootId &&
		a.startTicks === b.startTicks
	);
}

/** Consult the local host or its list after the kernel has confirmed its owner. */
export function hostedStanding(owner: TickedOwner): Standing {
	const host = hosted();
	if (host && host.key === owner.host && sameOwner(host.owner, owner)) {
		return host.holds(owner.session ?? "") === undefined ? "gone" : "running";
	}
	let read: unknown;
	try {
		read = JSON.parse(readFileSync(hostRegistryPath(owner), "utf8"));
	} catch {
		// An unreadable or missing registry cannot prove the session closed.
		return "unknown";
	}
	if (!isRegistry(read)) return "unknown";
	if (read.key !== owner.host || !sameOwner(read.owner, owner))
		return "unknown";
	return read.sessions.some((session) => session.id === owner.session)
		? "running"
		: "gone";
}

function isRegistry(value: unknown): value is HostRegistry {
	if (
		!value ||
		typeof value !== "object" ||
		!("key" in value) ||
		typeof value.key !== "string" ||
		!("owner" in value) ||
		!value.owner ||
		typeof value.owner !== "object" ||
		!("sessions" in value) ||
		!Array.isArray(value.sessions)
	)
		return false;
	const owner = value.owner;
	if (
		!("pid" in owner) ||
		typeof owner.pid !== "number" ||
		!("startedAt" in owner) ||
		typeof owner.startedAt !== "number"
	)
		return false;
	return value.sessions.every(
		(session: unknown) =>
			!!session &&
			typeof session === "object" &&
			"id" in session &&
			typeof session.id === "string" &&
			"state" in session &&
			["busy", "idle", "parked"].includes(String(session.state)) &&
			"since" in session &&
			typeof session.since === "string",
	);
}
