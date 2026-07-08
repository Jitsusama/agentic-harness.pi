/**
 * Pure model selection for a side completion.
 *
 * Choosing which model a side completion runs against is
 * independent of actually running it, so it lives here as a pure
 * function over a model list. The advisor and correction capture
 * both want the same order: an explicit target first, then a name
 * match, then a GLM-shaped model (the intended cheap watcher),
 * then the caller's current model as a last resort.
 */

/** The minimum a model reference needs for selection. */
export interface ModelRef {
	readonly id: string;
	readonly provider: string;
}

/** A caller's target: an explicit provider and/or model id. */
export interface ModelTarget {
	readonly provider?: string;
	readonly model?: string;
}

/** True when a model looks like a GLM / Zhipu model. */
export function looksLikeGlm(model: ModelRef): boolean {
	const needle = /glm|z-?ai|zhipu/i;
	return needle.test(model.id) || needle.test(model.provider);
}

/**
 * Choose a model for a side completion, in preference order:
 * an explicit provider+model resolved through `find`, then a
 * name match in `available`, then a GLM-shaped model, then the
 * caller's `current` model. Returns undefined when nothing fits.
 */
export function pickModel(
	available: ModelRef[],
	current: ModelRef | undefined,
	target: ModelTarget,
	find?: (provider: string, model: string) => ModelRef | undefined,
): ModelRef | undefined {
	if (target.provider && target.model) {
		const found = find?.(target.provider, target.model);
		if (found) return found;
	}
	if (target.model) {
		const byId = available.find((m) => m.id === target.model);
		if (byId) return byId;
	}
	// A provider named without a model still narrows the choice, per
	// the "provider and/or model" contract: honour it before the
	// GLM guess so an explicit request is not silently dropped.
	if (target.provider) {
		const byProvider = available.find((m) => m.provider === target.provider);
		if (byProvider) return byProvider;
	}
	return available.find(looksLikeGlm) ?? current;
}
