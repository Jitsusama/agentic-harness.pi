/**
 * Public surface of the people library.
 *
 * Handle-type registry, person-resolver chain and the
 * canonical identity types. Downstream packages use these
 * to resolve a free-form name or handle to an `Identity`,
 * and to register new handle types or resolvers.
 *
 * The disk-backed `PeopleStore` and its associated
 * `createPeopleStore` factory live under
 * `lib/internal/people/` (and the file at `./store.ts`).
 * They are not yet wired to a consumer in this package and
 * therefore are not part of the public barrel; a future PR
 * that wires a consumer can promote them intentionally.
 */

export {
	clearHandleTypes,
	getHandleType,
	listHandleTypes,
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
export type {
	Handle,
	HandleType,
	Identity,
	PersonResolver,
	ResolutionFallback,
	ResolveOptions,
} from "./types.js";
