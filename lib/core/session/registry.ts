/** Read a host's open sessions only after its process identity was checked. */
import { readdirSync, readFileSync } from "node:fs";
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
export function hostedStanding(
	owner: TickedOwner,
	readRegistry: (path: string) => HostRegistry | undefined = registryAt,
): Standing {
	const host = hosted();
	if (host && host.key === owner.host && sameOwner(host.owner, owner)) {
		return host.holds(owner.session ?? "") === undefined ? "gone" : "running";
	}
	const read = readRegistry(hostRegistryPath(owner));
	if (!read) return "unknown";
	if (read.key !== owner.host || !sameOwner(read.owner, owner))
		return "unknown";
	return read.sessions.some((session) => session.id === owner.session)
		? "running"
		: "gone";
}

/** Hold each host list once within one census or sweep, never across operations. */
export function askedHostOnce(): (owner: TickedOwner) => Standing {
	const lists = new Map<string, HostRegistry | undefined>();
	return (owner) =>
		hostedStanding(owner, (path) => {
			if (!lists.has(path)) lists.set(path, registryAt(path));
			return lists.get(path);
		});
}

/**
 * Every host list kept in the folder that reads as one, whether or not
 * its host still runs: the caller judges each owner itself.
 */
export function hostRegistries(dir = stateDir("hosts")): HostRegistry[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		// No folder: no host has run here since it was last cleared.
		return [];
	}
	return names
		.map((name) => registryAt(join(dir, name)))
		.filter((read): read is HostRegistry => read !== undefined);
}

function registryAt(path: string): HostRegistry | undefined {
	try {
		const read: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRegistry(read) ? read : undefined;
	} catch {
		// An unreadable or malformed list cannot prove a session closed.
		return undefined;
	}
}

function isRegistry(value: unknown): value is HostRegistry {
	if (
		!value ||
		typeof value !== "object" ||
		!("key" in value) ||
		typeof value.key !== "string" ||
		value.key.length === 0 ||
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
		typeof owner.startedAt !== "number" ||
		!Number.isSafeInteger(owner.pid) ||
		owner.pid <= 0 ||
		!Number.isFinite(owner.startedAt) ||
		("bootId" in owner && typeof owner.bootId !== "string") ||
		("startTicks" in owner &&
			(typeof owner.startTicks !== "number" ||
				!Number.isSafeInteger(owner.startTicks) ||
				owner.startTicks < 0))
	)
		return false;
	return value.sessions.every(
		(session: unknown) =>
			!!session &&
			typeof session === "object" &&
			"id" in session &&
			typeof session.id === "string" &&
			session.id.length > 0 &&
			"state" in session &&
			typeof session.state === "string" &&
			["busy", "idle", "parked"].includes(session.state) &&
			"since" in session &&
			typeof session.since === "string" &&
			Number.isFinite(Date.parse(session.since)),
	);
}
