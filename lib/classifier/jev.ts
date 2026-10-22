/**
 * Finding a classifier model to judge with, through the session's own
 * model registry, so the owner's model config decides where it is
 * served from and with what credentials.
 *
 * Unless one is named, it is the first of TypeSafe's Jev models in
 * pi's catalog that has credentials. Every caller has a way to do its
 * job without one, so none is a reason it gives, never a failure.
 */

import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Jev as pi's catalog lists it, in the order one is preferred. */
export const JEV_MODELS: readonly string[] = [
	"typesafe/jev-latest",
	"openrouter/typesafe/jev-1.13",
	"opencode/jev-1.13",
	"vercel-ai-gateway/typesafe-ai/jev",
	"cloudflare-workers-ai/typesafe/jev",
];

/** Asks one classifier, as a found one is called. */
export type Classify = (
	context: ClassifierContext,
	signal?: AbortSignal,
) => Promise<ClassifierResult>;

/** A classifier ready to call, or why there is none. */
export type FoundClassifier =
	| { readonly ok: true; readonly classify: Classify; readonly label: string }
	| {
			readonly ok: false;
			readonly reason: string;
			/** Switched off on purpose, so nobody needs telling. */
			readonly off?: true;
	  };

/**
 * The classifier to use: the one `named` gives as `provider/model`,
 * none when it is `off`, otherwise the first Jev with credentials.
 */
export async function findClassifier(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	named: string | undefined,
	setting: string,
): Promise<FoundClassifier> {
	const registry = ctx.modelRegistry;
	// A pi from before classifier models has neither call.
	if (
		typeof registry?.getAvailableOfType !== "function" ||
		typeof registry.classify !== "function"
	) {
		return { ok: false, reason: "this pi has no classifier models" };
	}
	const wanted = named?.trim();
	if (wanted === "off") {
		return { ok: false, reason: `${setting} is off`, off: true };
	}
	const available = await registry.getAvailableOfType("classifier");
	const byLabel = new Map(available.map((model) => [labelOf(model), model]));
	for (const label of wanted ? [wanted] : JEV_MODELS) {
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
		reason: wanted
			? `no classifier ${wanted} has credentials`
			: "no Jev classifier has credentials",
	};
}

function labelOf(model: ClassifierModel<ClassifierApi>): string {
	return `${model.provider}/${model.id}`;
}
