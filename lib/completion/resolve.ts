/**
 * Pure model selection for a side completion.
 *
 * Choosing which model a side completion runs against is
 * independent of actually running it, so it lives here as a pure
 * function over a model list. The advisor and correction capture
 * both want the same order: an explicit target first, then a name
 * match, then a GLM-shaped model (the intended cheap watcher),
 * then the caller's current model as a last resort.
 *
 * A registry can list a model its provider no longer serves, so
 * the order is a ranked list rather than a single pick: a caller
 * tries each in turn and moves past one that cannot be reached.
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
 * Rank the models a side completion may run against, best first:
 * an explicit provider+model resolved through `find`, then a name
 * match in `available`, then a provider match, then every
 * GLM-shaped model in registry order, then the caller's `current`
 * model. Each model appears once. Empty when nothing fits.
 */
export function rankModels(
	available: ModelRef[],
	current: ModelRef | undefined,
	target: ModelTarget,
	find?: (provider: string, model: string) => ModelRef | undefined,
): ModelRef[] {
	const ranked: ModelRef[] = [];
	const add = (model: ModelRef | undefined) => {
		if (!model) return;
		const seen = ranked.some(
			(m) => m.provider === model.provider && m.id === model.id,
		);
		if (!seen) ranked.push(model);
	};

	if (target.provider && target.model) {
		add(find?.(target.provider, target.model));
	}
	if (target.model) {
		add(available.find((m) => m.id === target.model));
	}
	// A provider named without a model still narrows the choice, per
	// the "provider and/or model" contract: honour it before the
	// GLM guess so an explicit request is not silently dropped.
	if (target.provider) {
		add(available.find((m) => m.provider === target.provider));
	}
	for (const model of available.filter(looksLikeGlm)) add(model);
	add(current);
	return ranked;
}

/**
 * Choose the model a side completion runs against first: the head
 * of `rankModels`. Returns undefined when nothing fits.
 */
export function pickModel(
	available: ModelRef[],
	current: ModelRef | undefined,
	target: ModelTarget,
	find?: (provider: string, model: string) => ModelRef | undefined,
): ModelRef | undefined {
	return rankModels(available, current, target, find)[0];
}

/**
 * True when an error says the model cannot be reached at all, as
 * opposed to failing this one request: not found or not deployed,
 * or the credentials refused. Only then is the next ranked model
 * worth trying; a rate limit or a bad prompt would fail the same way
 * or should reach the caller unchanged.
 */
export function isModelUnreachable(error: string): boolean {
	return /\b40[134]\b|not found|not deployed|does not exist|model_not_found|inaccessible|unauthori[sz]ed|forbidden/i.test(
		error,
	);
}
