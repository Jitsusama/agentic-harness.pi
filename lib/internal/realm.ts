/**
 * Which realm a session lives in, and where that realm keeps its own.
 *
 * A realm is a swarm of machines that link with each other and with no
 * other: Joel's personal machines in one, his work's in another, kept
 * apart completely. A machine may be in both, as two selves with a
 * mycelium node each (Joel, 29 October: "allowing a machine to join both
 * also makes sense"). A pi session belongs to one realm, set when it
 * starts, and sees only that realm's mesh, quests, steer inboxes and
 * memory. What the machine has only once, its cores, checkouts and
 * caches, stays shared.
 *
 * The session's realm is its `MYCELIUM_REALM`, as core sets it and as
 * the mycelium command reads it. Its home realm is `PI_HOME_REALM`, the
 * realm the machine is in first, which core sets beside it; unset, the
 * session's own realm is home. A session in its home realm keeps the
 * paths it always had, so nothing moves on a machine in one realm, and
 * a session in any other realm keeps its own under `realms/<name>/`.
 * No realm is named here: the machine says which is home.
 */

/** What a realm name may be: a folder name, and the node's word for it. */
const REALM_NAME = /^[a-z0-9-]+$/;

/** The realm a session is in, read from its environment. */
export type SessionRealm =
	| { readonly kind: "home" }
	| { readonly kind: "other"; readonly name: string }
	| { readonly kind: "unnamed"; readonly said: string };

/**
 * Where the session's realm keeps its own: home, in the paths always
 * used; another realm, by name; or a name no folder may carry, which
 * keeps home's paths and joins no mesh (see {@link meshRefusal}).
 */
export function sessionRealm(
	env: NodeJS.ProcessEnv = process.env,
): SessionRealm {
	const own = env.MYCELIUM_REALM?.trim();
	if (!own) return { kind: "home" };
	if (!REALM_NAME.test(own)) return { kind: "unnamed", said: own };
	const home = env.PI_HOME_REALM?.trim();
	return !home || home === own
		? { kind: "home" }
		: { kind: "other", name: own };
}

/**
 * The folders inside a root that hold the session's realm's own: none
 * for its home realm, `realms/<name>` for another.
 */
export function realmSegments(realm: SessionRealm = sessionRealm()): string[] {
	return realm.kind === "other" ? ["realms", realm.name] : [];
}

/**
 * Why the session must join no mesh, or undefined when it may: a realm
 * name that can't be a folder would put its mesh where no node and no
 * other session looks.
 */
export function meshRefusal(
	realm: SessionRealm = sessionRealm(),
): string | undefined {
	return realm.kind === "unnamed"
		? `MYCELIUM_REALM is "${realm.said}", which isn't a realm name (lowercase letters, digits and dashes), so this session joins no mesh.`
		: undefined;
}
