/**
 * A Node module-resolution hook that lets the maintenance scripts run
 * directly under Node's native TypeScript support.
 *
 * The library uses ESM-style `.js` import specifiers that point at
 * their `.ts` siblings (the runtime contract pi compiles). Node strips
 * types natively but does not rewrite a `.js` specifier to the `.ts`
 * file on disk, so a script that imports the library fails to resolve.
 * This hook rewrites a relative `.js` specifier to `.ts` when the `.js`
 * does not exist but the `.ts` does. It is a resolution shim, not a
 * build step: Node still does the type stripping.
 *
 * Register it with:
 *   node --import ./scripts/register-ts.mjs scripts/<name>.ts [args]
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
	if (
		specifier.endsWith(".js") &&
		(specifier.startsWith(".") || specifier.startsWith("/")) &&
		context.parentURL
	) {
		try {
			const jsUrl = new URL(specifier, context.parentURL);
			if (!existsSync(fileURLToPath(jsUrl))) {
				const tsSpecifier = specifier.replace(/\.js$/, ".ts");
				const tsUrl = new URL(tsSpecifier, context.parentURL);
				if (existsSync(fileURLToPath(tsUrl))) {
					return next(tsSpecifier, context);
				}
			}
		} catch {
			// Fall through to the default resolver on any URL parsing
			// error; the shim only ever adds a fallback, never blocks.
		}
	}
	return next(specifier, context);
}
