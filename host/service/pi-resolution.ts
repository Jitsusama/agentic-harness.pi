/**
 * Bind the harness's pi imports to the host's own pi. The harness keeps pi
 * as an optional peer its install never carries, and pi's loader aliases
 * it for the extensions pi loads; the host program runs under plain node,
 * where a module such as the viewer's terminal importing pi-tui would find
 * no pi at all, or in a tree the harness's dev copy. Resolving each
 * `@earendil-works/` import from the host's pi install instead gives the
 * program the one copy the engine and its screens run, the one the host's
 * build patched and tested. An install with the bundle's host entry keeps
 * that copy in its bundle, so each import resolves to the bundle's host
 * module for it; the install's own files would be a second copy, splitting
 * state such as pi-tui's kitty flag between the host and pi. This module
 * imports no pi, so it can be loaded before the hook is.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hostPiBundle, hostPiModule, PI_SCOPE } from "../engine/host-pi.ts";

/** The part of node's resolve context this hook reads and replaces. */
interface ResolveContext {
	parentURL?: string | undefined;
}

/** node's next resolver, as a synchronous resolve hook is handed it. */
type NextResolve<Context extends ResolveContext, Result> = (
	specifier: string,
	context?: Context,
) => Result;

/** A library name as pi publishes one: lowercase words, slashes between parts. */
const LIBRARY = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;

/**
 * A resolve hook for `module.registerHooks` that resolves each pi import
 * made from outside the host's pi install as the install would: from its
 * bundle's host module when it has a host entry, refusing a library the
 * bundle hands out no copy of, and otherwise from its root. pi's own
 * imports, and every other specifier, are left to node.
 */
export function piFromHost(packageDir: string) {
	const root = pathToFileURL(join(packageDir, "package.json")).href;
	const inside = pathToFileURL(join(packageDir, "/")).href;
	const bundled = existsSync(hostPiBundle(packageDir));
	return <Context extends ResolveContext, Result>(
		specifier: string,
		context: Context,
		next: NextResolve<Context, Result>,
	): Result => {
		if (
			!specifier.startsWith(PI_SCOPE) ||
			context.parentURL?.startsWith(inside)
		)
			return next(specifier, context);
		if (!bundled) return next(specifier, { ...context, parentURL: root });
		const module = hostPiModule(packageDir, specifier);
		if (!LIBRARY.test(specifier.slice(PI_SCOPE.length)) || !existsSync(module))
			throw new Error(
				`The host's pi bundle shares no ${specifier} with the host; loading the install's own would be a second copy beside the bundle's`,
			);
		return next(pathToFileURL(module).href, context);
	};
}
