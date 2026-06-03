/**
 * Disk-backed store for canonical people identities.
 *
 * One `PeopleStore` instance is scoped to one on-disk
 * directory. The directory holds one markdown file per
 * identity (`<id>.md`) plus per-namespace metadata in JSON
 * code blocks inside each file's body. Callers build a
 * store with `createPeopleStore({ dir })` and hold the
 * instance for the lifetime of the consumer that needs
 * it; there is no module-level singleton.
 *
 * The factory is not currently exported from
 * `lib/people/index.ts`: no consumer in this package wires
 * the store yet. A future PR that wires it should promote
 * the public surface in one step (factory plus types).
 */

import {
	get as getHandleType,
	list as listHandleTypes,
} from "../internal/people/registry.js";
import { PeopleStorage } from "../internal/people/storage.js";
import type { Handle, Identity } from "./types.js";

/** Options for creating an identity. */
export interface AddIdentityOptions {
	/**
	 * Stable id. Lowercase, kebab-case. When omitted, the
	 * store derives one from the first name (lowercased,
	 * spaces replaced with dashes). Conflicts on derived
	 * ids throw; explicit ids overwrite.
	 */
	id?: string;
	names?: string[];
	handles?: Array<Handle | string>;
}

/** Patch for updateIdentity. Fields are merged, not replaced. */
export interface UpdateIdentityPatch {
	names?: string[];
	handles?: Array<Handle | string>;
}

/** Public store interface. */
export interface PeopleStore {
	addIdentity(opts: AddIdentityOptions): Identity;
	updateIdentity(id: string, patch: UpdateIdentityPatch): Identity;
	addHandle(id: string, handle: Handle | string): Identity;
	addName(id: string, name: string): Identity;
	removeHandle(id: string, handle: Handle | string): Identity;
	removeName(id: string, name: string): Identity;
	deleteIdentity(id: string): void;
	setMetadata(
		id: string,
		namespace: string,
		data: Record<string, unknown>,
	): void;
	getMetadata(
		id: string,
		namespace: string,
	): Record<string, unknown> | undefined;
	getIdentity(id: string): Identity | undefined;
	findIdentity(query: string): Identity | undefined;
	findIdentities(query: string): Identity[];
	listIdentities(): Identity[];
	reload(): void;
}

function deriveId(names: string[] | undefined): string | undefined {
	if (!names || names.length === 0) return undefined;
	return names[0]
		.toLowerCase()
		.trim()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9.-]/g, "");
}

function normalizeHandle(input: Handle | string): Handle | undefined {
	if (typeof input !== "string") {
		const type = getHandleType(input.type);
		if (!type) return undefined;
		const parsed = type.parse(input.value);
		return parsed ? { type: input.type, value: parsed } : undefined;
	}
	const colon = input.indexOf(":");
	if (colon <= 0) return undefined;
	const typeId = input.slice(0, colon).trim();
	const raw = input.slice(colon + 1).trim();
	const type = getHandleType(typeId);
	if (!type) return undefined;
	const parsed = type.parse(raw);
	return parsed ? { type: typeId, value: parsed } : undefined;
}

function sameHandle(a: Handle, b: Handle): boolean {
	return a.type === b.type && a.value === b.value;
}

/** Score an identity against a free-form query, higher is better. */
function scoreMatch(identity: Identity, query: string): number {
	const q = query.trim();
	if (!q) return 0;
	const lower = q.toLowerCase();

	// Exact id match wins.
	if (identity.id === q || identity.id === lower) return 100;

	// Exact handle value match via any registered type.
	for (const type of listHandleTypes()) {
		const parsed = type.parse(q);
		if (parsed) {
			for (const h of identity.handles) {
				if (h.type === type.type && h.value === parsed) return 90;
			}
		}
	}

	// Exact name match (case-insensitive).
	for (const name of identity.names) {
		if (name.toLowerCase() === lower) return 80;
	}

	// Handle substring match.
	for (const h of identity.handles) {
		if (h.value.toLowerCase().includes(lower)) return 60;
	}

	// Name substring match.
	for (const name of identity.names) {
		if (name.toLowerCase().includes(lower)) return 50;
	}

	// Id substring.
	if (identity.id.includes(lower)) return 40;

	return 0;
}

class StoreImpl implements PeopleStore {
	constructor(private readonly storage: PeopleStorage) {}

	private mustGet(id: string) {
		const doc = this.storage.get(id);
		if (!doc) throw new Error(`No identity with id "${id}".`);
		return doc;
	}

	private normalizeHandlesOrThrow(
		inputs: Array<Handle | string> | undefined,
	): Handle[] {
		if (!inputs) return [];
		const out: Handle[] = [];
		for (const input of inputs) {
			const handle = normalizeHandle(input);
			if (!handle) {
				const display =
					typeof input === "string" ? input : `${input.type}:${input.value}`;
				throw new Error(
					`Cannot parse handle "${display}": no matching handle type registered, or value is invalid.`,
				);
			}
			out.push(handle);
		}
		return out;
	}

	addIdentity(opts: AddIdentityOptions): Identity {
		const id = opts.id ?? deriveId(opts.names);
		if (!id) {
			throw new Error(
				"addIdentity needs either an explicit id or at least one name to derive one from.",
			);
		}
		const existing = this.storage.get(id);
		if (existing && opts.id === undefined) {
			throw new Error(
				`Identity "${id}" already exists; pass an explicit id to overwrite.`,
			);
		}
		const handles = this.normalizeHandlesOrThrow(opts.handles);
		const identity: Identity = {
			id,
			names: opts.names ? [...opts.names] : [],
			handles,
		};
		this.storage.write({
			identity,
			metadata: existing?.metadata ?? {},
			body: existing?.body ?? "",
		});
		return identity;
	}

	updateIdentity(id: string, patch: UpdateIdentityPatch): Identity {
		const doc = this.mustGet(id);
		const identity: Identity = {
			id: doc.identity.id,
			names: patch.names ? [...patch.names] : [...doc.identity.names],
			handles: patch.handles
				? this.normalizeHandlesOrThrow(patch.handles)
				: doc.identity.handles,
		};
		this.storage.write({ ...doc, identity });
		return identity;
	}

	addHandle(id: string, handle: Handle | string): Identity {
		const doc = this.mustGet(id);
		const normalized = normalizeHandle(handle);
		if (!normalized) {
			const display =
				typeof handle === "string" ? handle : `${handle.type}:${handle.value}`;
			throw new Error(`Cannot parse handle "${display}".`);
		}
		if (doc.identity.handles.some((h) => sameHandle(h, normalized))) {
			return doc.identity;
		}
		const identity: Identity = {
			...doc.identity,
			handles: [...doc.identity.handles, normalized],
		};
		this.storage.write({ ...doc, identity });
		return identity;
	}

	addName(id: string, name: string): Identity {
		const doc = this.mustGet(id);
		const trimmed = name.trim();
		if (!trimmed) return doc.identity;
		if (doc.identity.names.includes(trimmed)) return doc.identity;
		const identity: Identity = {
			...doc.identity,
			names: [...doc.identity.names, trimmed],
		};
		this.storage.write({ ...doc, identity });
		return identity;
	}

	removeHandle(id: string, handle: Handle | string): Identity {
		const doc = this.mustGet(id);
		const normalized = normalizeHandle(handle);
		if (!normalized) return doc.identity;
		const handles = doc.identity.handles.filter(
			(h) => !sameHandle(h, normalized),
		);
		if (handles.length === doc.identity.handles.length) return doc.identity;
		const identity: Identity = { ...doc.identity, handles };
		this.storage.write({ ...doc, identity });
		return identity;
	}

	removeName(id: string, name: string): Identity {
		const doc = this.mustGet(id);
		const names = doc.identity.names.filter((n) => n !== name);
		if (names.length === doc.identity.names.length) return doc.identity;
		const identity: Identity = { ...doc.identity, names };
		this.storage.write({ ...doc, identity });
		return identity;
	}

	deleteIdentity(id: string): void {
		this.storage.delete(id);
	}

	setMetadata(
		id: string,
		namespace: string,
		data: Record<string, unknown>,
	): void {
		const doc = this.mustGet(id);
		const metadata = { ...doc.metadata, [namespace]: { ...data } };
		this.storage.write({ ...doc, metadata });
	}

	getMetadata(
		id: string,
		namespace: string,
	): Record<string, unknown> | undefined {
		const doc = this.storage.get(id);
		if (!doc) return undefined;
		const slot = doc.metadata[namespace];
		return slot ? { ...slot } : undefined;
	}

	getIdentity(id: string): Identity | undefined {
		return this.storage.get(id)?.identity;
	}

	findIdentity(query: string): Identity | undefined {
		const matches = this.findIdentities(query);
		return matches[0];
	}

	findIdentities(query: string): Identity[] {
		const scored = this.storage
			.list()
			.map((doc) => ({
				identity: doc.identity,
				score: scoreMatch(doc.identity, query),
			}))
			.filter((m) => m.score > 0);
		scored.sort((a, b) => b.score - a.score);
		return scored.map((m) => m.identity);
	}

	listIdentities(): Identity[] {
		return this.storage.list().map((doc) => doc.identity);
	}

	reload(): void {
		this.storage.reload();
	}
}

/**
 * Build a fresh people store backed by the given directory.
 * The directory does not need to exist; it is created
 * lazily on the first write.
 */
export function createPeopleStore(opts: { dir: string }): PeopleStore {
	return new StoreImpl(new PeopleStorage(opts.dir));
}
