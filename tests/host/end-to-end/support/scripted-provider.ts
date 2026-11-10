/**
 * The scripted model as an extension, for a plain pi in the seal: E5
 * opens a hosted conversation's log in `pi --session` with this loaded
 * by `-e`, so the conversation goes on answering as it did in its host.
 * It registers the scripted provider under the api the seal's
 * models.json names, its stream taken from pi-ai's faux provider in the
 * pi PI_HOST_PACKAGE_DIR names.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	fauxOf,
	SCRIPTED,
	SCRIPTED_API,
	SCRIPTED_MODELS,
	SCRIPTED_URL,
	scriptedCore,
} from "./scripted-model.ts";

/** Register the scripted provider, before pi picks its model. */
export default async function scriptedProvider(
	pi: ExtensionAPI,
): Promise<void> {
	const packageDir = process.env.PI_HOST_PACKAGE_DIR;
	if (!packageDir)
		throw new Error(
			"PI_HOST_PACKAGE_DIR names no pi to take the faux provider from",
		);
	const core = scriptedCore(await fauxOf(packageDir));
	pi.registerProvider(SCRIPTED.provider, {
		baseUrl: SCRIPTED_URL,
		// A plain pi holds no host's key; the faux provider asks for none.
		apiKey: "sealed-key",
		api: SCRIPTED_API,
		models: SCRIPTED_MODELS,
		streamSimple: core.streamSimple,
	});
}
