/**
 * Public surface of the people library.
 *
 * Storage of canonical people identities (names + handles)
 * backed by markdown files on disk. Extensions register
 * metadata against any identity in their own namespace.
 *
 * Most callers use `createPeopleStore({ dir })` to build a
 * store object scoped to a specific directory. The quest
 * extension uses `dataDir("people") + "/registry"` as its
 * dir; tests pass a tmp directory.
 */

export {
	clearHandleTypes,
	registerBuiltinHandleTypes,
	registerHandleType,
	unregisterHandleType,
} from "./register.js";
export {
	clearPersonResolvers,
	getPersonResolver,
	getResolutionFallback,
	listPersonResolvers,
	registerBuiltinPersonResolvers,
	registerPersonResolver,
	resolveIdentity,
	setResolutionFallback,
	unregisterPersonResolver,
} from "./resolve.js";
export {
	type AddIdentityOptions,
	createPeopleStore,
	type PeopleStore,
	type UpdateIdentityPatch,
} from "./store.js";
export type {
	Handle,
	HandleType,
	Identity,
	PersonResolver,
	ResolutionFallback,
	ResolveOptions,
} from "./types.js";
