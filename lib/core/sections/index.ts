export { violationSignature } from "../gate/index.ts";
export { formatSectionBlock } from "./block.ts";
export {
	composePrBody,
	PR_FIELDS,
	type PrFields,
	readPrFields,
	reviseFields,
	unwrapProse,
} from "./compose.ts";
export {
	detectSectionViolations,
	type SectionViolation,
} from "./detect.ts";
export {
	type BodyViolation,
	detectBodyViolations,
	formatBodyBlock,
	type SectionGateConfig,
	type SectionGateDecision,
	sectionGateDecision,
} from "./gate.ts";
export { ISSUE_SECTIONS, PR_SECTIONS, PR_SHAPE } from "./sanctioned.ts";
export {
	type BodyShape,
	countWords,
	detectShapeViolations,
	type SectionShape,
	type ShapeRule,
	type ShapeViolation,
	sentencesOf,
} from "./shape.ts";
export { formatShapeBlock } from "./shape-block.ts";
export type { SectionWording, WordingRule } from "./wording.ts";
