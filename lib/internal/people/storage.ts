/**
 * Disk-backed storage for the people registry. Reads and
 * writes one markdown file per identity in the registry
 * directory.
 *
 * The store is lazy: identities are loaded on first read
 * and cached. Writes update the cache and the file in one
 * step. Callers that want a fresh view (e.g. after editing
 * a file by hand) call `reload`.
 *
 * Disk shape:
 *
 *     <dir>/
 *       joel-gerber.md
 *       xiao-li.md
 *       chao-duan.md
 *
 * Filenames are `{id}.md`. Identity ids therefore must be
 * safe filename characters: lowercase letters, digits, dash
 * and dot. The store validates ids on write.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import type { Handle, Identity } from "../../people/types.js";
import { type IdentityDoc, parseIdentity, serializeIdentity } from "./doc.js";

const VALID_ID_REGEX = /^[a-z0-9][a-z0-9.-]*$/;

function assertValidId(id: string): void {
	if (!VALID_ID_REGEX.test(id)) {
		throw new Error(
			`Invalid identity id "${id}": must be lowercase alphanumeric, dot or dash, starting with a letter or digit.`,
		);
	}
}

/** In-memory representation of the registry directory. */
export class PeopleStorage {
	private cache = new Map<string, IdentityDoc>();
	private loaded = false;

	constructor(private readonly dir: string) {}

	/** Force a fresh re-read on next access. */
	reload(): void {
		this.cache.clear();
		this.loaded = false;
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		this.loaded = true;
		let entries: string[];
		try {
			entries = readdirSync(this.dir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
			throw err;
		}
		for (const entry of entries) {
			if (extname(entry) !== ".md") continue;
			const full = join(this.dir, entry);
			let text: string;
			try {
				text = readFileSync(full, "utf8");
			} catch {
				// Skip files that can no longer be read.
				// Race conditions during scan are not the
				// store's problem.
				continue;
			}
			const doc = parseIdentity(text);
			if (!doc) continue;
			this.cache.set(doc.identity.id, doc);
		}
	}

	list(): IdentityDoc[] {
		this.ensureLoaded();
		return [...this.cache.values()].map((doc) => cloneDoc(doc));
	}

	get(id: string): IdentityDoc | undefined {
		this.ensureLoaded();
		const doc = this.cache.get(id);
		return doc ? cloneDoc(doc) : undefined;
	}

	write(doc: IdentityDoc): void {
		assertValidId(doc.identity.id);
		this.ensureLoaded();
		mkdirSync(this.dir, { recursive: true });
		const file = join(this.dir, `${doc.identity.id}.md`);
		writeFileSync(file, serializeIdentity(doc), "utf8");
		this.cache.set(doc.identity.id, cloneDoc(doc));
	}

	delete(id: string): void {
		this.ensureLoaded();
		this.cache.delete(id);
		const file = join(this.dir, `${id}.md`);
		try {
			rmSync(file, { force: true });
		} catch {
			// File may already be gone; deletion is
			// idempotent.
		}
	}
}

function cloneDoc(doc: IdentityDoc): IdentityDoc {
	return {
		identity: cloneIdentity(doc.identity),
		metadata: JSON.parse(JSON.stringify(doc.metadata)),
		body: doc.body,
	};
}

function cloneIdentity(identity: Identity): Identity {
	return {
		id: identity.id,
		names: [...identity.names],
		handles: identity.handles.map(
			(h): Handle => ({ type: h.type, value: h.value }),
		),
	};
}
