// Not a call but a loader for the real one, given to node with --import: it answers `@napi-rs/keyring` with a module shaped as KEYRING_MODULE says, so the real call meets a module lacking its entry ("none") or every call but getPassword ("reads").
import { register } from "node:module";

const NONE = "export const nothing = 1;";

/** @type {Record<string, string>} */
const SHAPES = {
	none: NONE,
	reads: "export class AsyncEntry { async getPassword() { return null; } }",
};

if (new URL(import.meta.url).search !== "?hooks") {
	register(`${import.meta.url}?hooks`);
}

/**
 * Answers the keyring module with the shape asked for, and anything else as usual.
 *
 * @param {string} specifier
 * @param {unknown} context
 * @param {(specifier: string, context: unknown) => unknown} next
 */
export async function resolve(specifier, context, next) {
	if (specifier !== "@napi-rs/keyring") return next(specifier, context);
	const shape = SHAPES[process.env.KEYRING_MODULE ?? ""] ?? NONE;
	return {
		url: `data:text/javascript,${encodeURIComponent(shape)}`,
		shortCircuit: true,
	};
}
