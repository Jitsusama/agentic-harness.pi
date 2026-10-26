/**
 * Resolve hooks that let a plain node child import this package's
 * TypeScript source.
 *
 * Node strips the types itself. What it will not do is read the `.js`
 * an import names as the `.ts` beside it, which is how every import in
 * this package is written, so a child spawned to be a second process
 * could not load the code it is meant to exercise. This retries a
 * relative `.js` that does not resolve as the `.ts` of the same name.
 */

/** Resolve as node would, falling back to the `.ts` of a missing `.js`. */
export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (error) {
		const relative = specifier.startsWith(".") || specifier.startsWith("/");
		if (!relative || !specifier.endsWith(".js")) throw error;
		return next(`${specifier.slice(0, -3)}.ts`, context);
	}
}
