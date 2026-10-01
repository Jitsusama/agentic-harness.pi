/**
 * The classifier model that tags paragraphs.
 *
 * It is one of pi's classifier models, found in the session's model
 * registry and called through it, so the owner's model config decides
 * where it is served from and with what credentials. Unless one is
 * named, it is the first of TypeSafe's Jev models in pi's catalog that
 * has credentials, which is the model the selection was tested with.
 */

import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Classifier } from "../../lib/compaction/selection/classify.ts";

/**
 * The environment variable naming the classifier as `provider/model`,
 * or `off` for none.
 */
export const CLASSIFIER_ENV = "PI_COMPACTION_CLASSIFIER";

/** Jev as pi's catalog lists it, in the order one is preferred. */
export const JEV_MODELS: readonly string[] = [
	"typesafe/jev-latest",
	"openrouter/typesafe/jev-1.13",
	"opencode/jev-1.13",
	"vercel-ai-gateway/typesafe-ai/jev",
	"cloudflare-workers-ai/typesafe/jev",
];

/** A classifier ready to call, or why there is none. */
export type ResolvedClassifier =
	| {
			readonly ok: true;
			readonly classify: Classifier;
			/** The model as `provider/model`. */
			readonly label: string;
	  }
	| { readonly ok: false; readonly reason: string };

/** The classifier to use, resolved through the session's registry. */
export async function resolveClassifier(
	ctx: ExtensionContext,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedClassifier> {
	const registry = ctx.modelRegistry;
	// A pi from before classifier models has neither call.
	if (
		typeof registry.getAvailableOfType !== "function" ||
		typeof registry.classify !== "function"
	) {
		return { ok: false, reason: "this pi has no classifier models" };
	}
	const named = env[CLASSIFIER_ENV]?.trim();
	if (named === "off") return { ok: false, reason: `${CLASSIFIER_ENV} is off` };
	const wanted = named ? [named] : JEV_MODELS;
	const available = await registry.getAvailableOfType("classifier");
	const byLabel = new Map(available.map((model) => [labelOf(model), model]));
	for (const label of wanted) {
		const model = byLabel.get(label);
		if (!model) continue;
		return {
			ok: true,
			label,
			classify: (context, signal) =>
				registry.classify(model, context, { signal }),
		};
	}
	return {
		ok: false,
		reason: named
			? `no classifier ${named} has credentials`
			: "no Jev classifier has credentials",
	};
}

function labelOf(model: ClassifierModel<ClassifierApi>): string {
	return `${model.provider}/${model.id}`;
}
