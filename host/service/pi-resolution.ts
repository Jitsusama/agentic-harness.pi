/**
 * Bind the harness's pi imports to the host's own pi. The harness keeps pi
 * as an optional peer its install never carries, and pi's loader aliases
 * it for the extensions pi loads; the host program runs under plain node,
 * where a module such as the viewer's terminal importing pi-tui would find
 * no pi at all, or in a tree the harness's dev copy. Resolving each
 * `@earendil-works/` import from the host's pi install instead gives the
 * program the one copy the engine and its screens run, the one the host's
 * build patched and tested. This module imports no pi, so it can be loaded
 * before the hook is.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The scope every pi library is published under. */
const PI_SCOPE = "@earendil-works/";

/** The part of node's resolve context this hook reads and replaces. */
interface ResolveContext {
	parentURL?: string | undefined;
}

/** node's next resolver, as a synchronous resolve hook is handed it. */
type NextResolve<Context extends ResolveContext, Result> = (
	specifier: string,
	context?: Context,
) => Result;

/**
 * A resolve hook for `module.registerHooks` that resolves each pi import
 * made from outside the host's pi install as the install would, from its
 * root. pi's own imports, and every other specifier, are left to node.
 */
export function piFromHost(packageDir: string) {
	const root = pathToFileURL(join(packageDir, "package.json")).href;
	const inside = pathToFileURL(join(packageDir, "/")).href;
	return <Context extends ResolveContext, Result>(
		specifier: string,
		context: Context,
		next: NextResolve<Context, Result>,
	): Result =>
		specifier.startsWith(PI_SCOPE) && !context.parentURL?.startsWith(inside)
			? next(specifier, { ...context, parentURL: root })
			: next(specifier, context);
}
