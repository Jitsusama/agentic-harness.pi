/**
 * The model that classifies paragraphs, as the owner configured it.
 *
 * It is named by `PI_COMPACTION_CLASSIFIER` as `provider/model` and
 * found in pi's model registry, and every call goes through the
 * registry, so whatever the owner's model config puts behind that name
 * is what answers: a small general model, or a provider serving a model
 * built for classification. Nothing here knows which.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClassifierCall } from "../../lib/classifier/index.ts";

/** The environment variable naming the classifier model. */
export const CLASSIFIER_ENV = "PI_COMPACTION_CLASSIFIER";

/** Enough output for every answer to a large message, with room to spare. */
const CLASSIFIER_MAX_TOKENS = 8192;

/** A classifier ready to call, or why there is none. */
export type ResolvedClassifier =
	| { readonly ok: true; readonly call: ClassifierCall; readonly label: string }
	| { readonly ok: false; readonly reason: string };

/** The classifier the environment names, resolved through the session's registry. */
export function resolveClassifier(
	ctx: ExtensionContext,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedClassifier {
	const named = env[CLASSIFIER_ENV]?.trim();
	if (!named) return { ok: false, reason: `${CLASSIFIER_ENV} is not set` };
	const slash = named.indexOf("/");
	if (slash <= 0 || slash === named.length - 1) {
		return {
			ok: false,
			reason: `${CLASSIFIER_ENV} should be provider/model, not ${named}`,
		};
	}
	const registry = ctx.modelRegistry;
	const model = registry.find(named.slice(0, slash), named.slice(slash + 1));
	if (!model) return { ok: false, reason: `no model ${named} is configured` };
	if (!registry.hasConfiguredAuth(model)) {
		return { ok: false, reason: `no credentials are configured for ${named}` };
	}
	const sessionId = ctx.sessionManager.getSessionId();
	return {
		ok: true,
		label: named,
		call: (context, signal) =>
			registry
				.streamSimple(model, context, {
					signal,
					sessionId,
					maxTokens: Math.min(CLASSIFIER_MAX_TOKENS, model.maxTokens),
				})
				.result(),
	};
}
