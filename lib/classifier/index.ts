/**
 * Classifier: yes-or-no questions about short units of text, asked of
 * any model as an ordinary chat request with one answer tool, and
 * answered with the probability that each is yes.
 *
 * Pure and standalone. The call to the model is handed in, so an
 * extension routes it through pi's model registry and the owner's
 * model config decides what serves it. {@link requestFromContext} is
 * the other side of the seam, for a provider in that config which
 * serves a model built for classification.
 */

export {
	type Classification,
	type ClassifierCall,
	classify,
	readAnswers,
} from "./classify.ts";
export {
	ANSWER_TOOL_NAME,
	CLASSIFICATION_CONTRACT,
	type ClassificationAnswers,
	type ClassificationQuestion,
	type ClassificationRequest,
	type ClassificationUnit,
	isClassificationRequest,
} from "./contract.ts";
export { classificationContext, requestFromContext } from "./prompt.ts";
