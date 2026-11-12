/**
 * The scripted model as an extension that wants the gateway key, as
 * Shopify's proxy extension registers its providers: its key is
 * `$SHOPIFY_PROXY_KEY`, which pi reads from the environment, so a pi
 * started without that variable refuses every request with "No API key
 * found". E16 hands it to a hosted conversation's subagents, whose host
 * holds no key in its own environment.
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

/** Register the scripted provider on the gateway key, before pi picks its model. */
export default async function keyedProvider(pi: ExtensionAPI): Promise<void> {
	const packageDir = process.env.PI_HOST_PACKAGE_DIR;
	if (!packageDir)
		throw new Error(
			"PI_HOST_PACKAGE_DIR names no pi to take the faux provider from",
		);
	const core = scriptedCore(await fauxOf(packageDir));
	pi.registerProvider(SCRIPTED.provider, {
		baseUrl: SCRIPTED_URL,
		apiKey: "$SHOPIFY_PROXY_KEY",
		api: SCRIPTED_API,
		models: SCRIPTED_MODELS,
		streamSimple: core.streamSimple,
	});
}
