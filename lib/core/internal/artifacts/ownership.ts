/** Ownership shared by result payloads and web bundles, independent of the host engine. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	askedOnceWithTicks,
	keepTicks,
	type Standing,
	tickedOwnerNow,
	tickedStanding,
	tickFacts,
} from "../../../internal/process-ticks.ts";
import { isOwner } from "../../process/index.ts";
import { requireSession } from "../../session/identity.ts";
import {
	hosted,
	type SessionOwner,
	type SessionRef,
	sessionSlot,
} from "../../session/index.ts";

interface Capture {
	pending?: Promise<SessionOwner | undefined>;
	owner?: SessionOwner;
}
interface ArtifactOwner {
	version: 1;
	session: string;
	owner: SessionOwner;
}

/** Encode caller identity as one safe directory component; plain library calls retain their pid. */
export function artifactSessionKey(ref?: SessionRef): string {
	const id =
		ref === undefined && !hosted() ? String(process.pid) : requireSession(ref);
	if (!id || id === "." || id === "..")
		throw new Error("An artifact directory needs a session id.");
	return id;
}

/** Capture plain-pi ownership before tools run, without creating any artifact directories. */
export async function prepareArtifactOwnership(
	ref?: SessionRef,
): Promise<void> {
	if (hosted()) {
		artifactSessionKey(ref);
		return;
	}
	const capture = sessionSlot<Capture>(
		"pi:artifact-process-owner",
		ref,
		() => ({}),
	);
	capture.pending ??= tickedOwnerNow();
	capture.owner = await capture.pending;
}

function ownerFor(ref?: SessionRef): SessionOwner | undefined {
	const host = hosted();
	if (host)
		return { ...host.owner, session: artifactSessionKey(ref), host: host.key };
	return sessionSlot<Capture>("pi:artifact-process-owner", ref, () => ({}))
		.owner;
}

/** Claim an existing directory after a write, best-effort; unclaimed artifacts are never reaped. */
export function claimArtifactDirectory(dir: string, ref?: SessionRef): void {
	const owner = ownerFor(ref);
	if (!owner) return;
	const record: ArtifactOwner = {
		version: 1,
		session: artifactSessionKey(ref),
		owner,
	};
	const target = path.join(dir, "owner.json");
	const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const next = JSON.stringify(record);
		if (!fs.existsSync(dir)) return;
		if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === next)
			return;
		fs.writeFileSync(tmp, next, { mode: 0o600 });
		fs.renameSync(tmp, target);
	} catch {
		// A failed metadata write must not lose a successful payload; unknown owners are retained.
	} finally {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// Failed housekeeping does not change the payload or its ownership.
		}
	}
}

/** The durable catalogue must distinguish unavailable evidence from a definitive close. */
export type HeldSessionStatus = "held" | "unheld" | "unknown";

/** Facts for a bounded destructive sweep, injectable against a throwaway root. */
export interface ArtifactReaping {
	root: string;
	standing?: (owner: SessionOwner) => Promise<Standing>;
	/** Asked with the host key the owner record names, so a missing roster for it reads as doubt. */
	heldSessionStatus?: (
		sessionId: string,
		hostKey?: string,
	) => Promise<HeldSessionStatus>;
}

function recordOf(text: string, name: string): ArtifactOwner | undefined {
	let read: unknown;
	try {
		read = JSON.parse(text);
	} catch {
		// Malformed ownership cannot authorize deletion.
		return undefined;
	}
	if (
		typeof read !== "object" ||
		read === null ||
		!("version" in read) ||
		read.version !== 1 ||
		!("session" in read) ||
		typeof read.session !== "string" ||
		encodeURIComponent(read.session) !== name ||
		!("owner" in read) ||
		!isOwner(read.owner)
	)
		return undefined;
	if (read.owner.session !== undefined && read.owner.session !== read.session)
		return undefined;
	return { version: 1, session: read.session, owner: keepTicks(read.owner) };
}

/** Reap only proven abandoned artifacts; a hosted one also needs the catalogue's definitive unheld. */
export async function reapSessionArtifacts(
	opts: ArtifactReaping,
): Promise<void> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(opts.root, { withFileTypes: true });
	} catch {
		// Missing or unreadable roots cannot contain anything we can safely reclaim.
		return;
	}
	const facts = askedOnceWithTicks(tickFacts);
	const standing = opts.standing ?? ((owner) => tickedStanding(owner, facts));
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(opts.root, entry.name);
		const file = path.join(dir, "owner.json");
		try {
			const before = fs.readFileSync(file, "utf8");
			const record = recordOf(before, entry.name);
			if (!record || (await standing(record.owner)) !== "gone") continue;
			if (
				record.owner.session !== undefined &&
				(await opts.heldSessionStatus?.(record.session, record.owner.host)) !==
					"unheld"
			)
				continue;
			// A resumed session may have claimed the directory while liveness was being checked.
			if (fs.readFileSync(file, "utf8") !== before) continue;
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Unreadable metadata, unavailable liveness or failed cleanup are retried on a later start.
		}
	}
}
