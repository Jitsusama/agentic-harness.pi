/**
 * Bind the harness's pi imports to the host's own pi. The harness keeps pi
 * as an optional peer its install never carries, and pi's loader aliases
 * it for the extensions pi loads; the host program runs under plain node,
 * where a module such as the viewer's terminal importing pi-tui would find
 * no pi at all, or in a tree the harness's dev copy. Resolving each
 * `@earendil-works/` import from the host's pi install instead gives the
 * program the one copy the engine and its screens run, the one the host's
 * build patched and tested. typebox is taken the same way, so the host's
 * protocol is checked by the TypeBox each conversation's pi already holds
 * rather than a validation library of the host's own. An install with the
 * bundle's host entry keeps that copy in its bundle, so each import
 * resolves to the bundle's host module for it; the install's own files
 * would be a second copy, splitting state such as pi-tui's kitty flag
 * between the host and pi. This module imports no pi, so it can be loaded
 * before the hook is.
 *
 * The host's protocol imports typebox as the program loads, before the
 * program has judged its pi, so a pi with no typebox to give falls back to
 * the harness's own copy rather than failing that load: the program then
 * refuses the pi as it starts, with the status a unit holds on, and no
 * conversation is served by the second copy.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	hostModuleName,
	hostPiBundle,
	hostPiModule,
	takenFromPi,
} from "../engine/host-pi.ts";

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

/** Whether the harness carries its own copy of `specifier`, as it does typebox's and no pi library's. */
function carriedByHarness(specifier: string): boolean {
	return specifier === "typebox" || specifier.startsWith("typebox/");
}

/**
 * A resolve hook for `module.registerHooks` that resolves each import of
 * pi or typebox made from outside the host's pi install as the install
 * would: from its bundle's host module when it has a host entry, refusing
 * a pi library the bundle hands out no copy of, and otherwise from its
 * root. typebox that the install can't give comes from the harness's own
 * copy, for the program to refuse the install as it starts. pi's own
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
		if (!takenFromPi(specifier) || context.parentURL?.startsWith(inside))
			return next(specifier, context);
		if (!bundled) {
			if (!carriedByHarness(specifier))
				return next(specifier, { ...context, parentURL: root });
			// node merges each context passed on into this one, so the asking
			// module is kept before the first ask overwrites it.
			const asked = context.parentURL;
			try {
				return next(specifier, { ...context, parentURL: root });
			} catch {
				return next(specifier, { ...context, parentURL: asked });
			}
		}
		const module = hostPiModule(packageDir, specifier);
		const shared =
			LIBRARY.test(hostModuleName(specifier)) && existsSync(module);
		if (!shared && carriedByHarness(specifier)) return next(specifier, context);
		if (!shared)
			throw new Error(
				`The host's pi bundle shares no ${specifier} with the host; loading the install's own would be a second copy beside the bundle's`,
			);
		return next(pathToFileURL(module).href, context);
	};
}
