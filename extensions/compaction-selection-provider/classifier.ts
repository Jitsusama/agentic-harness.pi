/**
 * The classifier model that tags paragraphs.
 *
 * It is one of pi's classifier models, found in the session's model
 * registry and called through it, so the owner's model config decides
 * where it is served from and with what credentials. Unless one is
 * named, it is the first of TypeSafe's Jev models in pi's catalog that
 * has credentials, which is the model the selection was tested with.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findClassifier } from "../../lib/classifier/jev.ts";
import type { Classifier } from "../../lib/compaction/selection/classify.ts";

export { JEV_MODELS } from "../../lib/classifier/jev.ts";

/**
 * The environment variable naming the classifier as `provider/model`,
 * or `off` for none.
 */
export const CLASSIFIER_ENV = "PI_COMPACTION_CLASSIFIER";

/** A classifier ready to call, or why there is none. */
export type ResolvedClassifier =
	| {
			readonly ok: true;
			readonly classify: Classifier;
			/** The model as `provider/model`. */
			readonly label: string;
	  }
	| {
			readonly ok: false;
			readonly reason: string;
			/** Switched off on purpose, so nobody needs telling. */
			readonly off?: true;
	  };

/** The classifier to use, resolved through the session's registry. */
export async function resolveClassifier(
	ctx: ExtensionContext,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedClassifier> {
	return findClassifier(ctx, env[CLASSIFIER_ENV], CLASSIFIER_ENV);
}

/** What the selection last found of its classifier, for its records. */
export type ClassifierState =
	| { readonly label: string }
	| { readonly unavailable: string }
	| { readonly unresolved: true };

/**
 * The classifier, resolved for whoever needs it, with the last answer
 * kept for a reader that cannot wait for one. The first time in a
 * session that there is none, and not because somebody turned it off,
 * the person is told once: without one the selection quotes nothing,
 * and nothing else would say so.
 */
export interface ClassifierStatus {
	resolve(ctx: ExtensionContext): Promise<ResolvedClassifier>;
	current(): ClassifierState;
	/** A new session: forget the answer, and tell again if need be. */
	reset(): void;
}

/** A shared status, resolving through {@link resolveClassifier}. */
export function classifierStatus(
	resolveWith: (
		ctx: ExtensionContext,
	) => Promise<ResolvedClassifier> = resolveClassifier,
): ClassifierStatus {
	let state: ClassifierState = { unresolved: true };
	let told = false;
	return {
		async resolve(ctx) {
			const resolved = await resolveWith(ctx);
			state = resolved.ok
				? { label: resolved.label }
				: { unavailable: resolved.reason };
			if (!resolved.ok && !resolved.off && !told && ctx.hasUI) {
				told = true;
				ctx.ui.notify(
					`Compaction excerpts are off: ${resolved.reason}. Set ${CLASSIFIER_ENV} to a classifier model as provider/model, or to off to stop this notice.`,
					"info",
				);
			}
			return resolved;
		},
		current: () => state,
		reset() {
			state = { unresolved: true };
			told = false;
		},
	};
}
