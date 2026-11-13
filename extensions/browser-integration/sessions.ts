/**
 * The browser sessions, made on the first call that needs them.
 *
 * The browser engine is 126 modules that every pi start loaded, though
 * most sessions never open a browser: about 7% of what a start loaded on
 * 4 November. The tools register from light files (`*-tool.ts`) and
 * load what they do, the registry and the engine with it, on their
 * first call.
 */

import { loadOnce } from "../../lib/internal/single-flight.ts";
import type { RegistryOptions, SessionRegistry } from "./registry.ts";

const registryModule = loadOnce(() => import("./registry.ts"));

/** The registry, made on first use and the same one after. */
export type Sessions = () => Promise<SessionRegistry>;

/** The sessions, and putting down every one opened, if any were. */
export interface LazySessions {
	readonly sessions: Sessions;
	disposeAll(): Promise<void>;
}

/** Sessions whose registry, and the engine under it, load on first use. */
export function lazySessions(
	options: Pick<RegistryOptions, "ownsBrowser" | "artifactRef"> = {},
): LazySessions {
	let made: Promise<SessionRegistry> | undefined;
	return {
		sessions: () => {
			made ??= registryModule().then((registry) =>
				registry.createSessionRegistry(options),
			);
			return made;
		},
		async disposeAll() {
			// Nothing to put down when no call ever needed a browser.
			if (made) await (await made).disposeAll();
		},
	};
}
