export { violationSignature } from "../../gate/index.ts";
export { formatSectionBlock } from "./block.ts";
export {
	composePrBody,
	readPrFields,
	reviseFields,
	unwrapProse,
} from "./compose.ts";
export {
	detectSectionViolations,
	type SectionViolation,
} from "./detect.ts";
export {
	detectBodyViolations,
	sectionGateDecision,
} from "./gate.ts";
export {
	ISSUE_SECTIONS,
	PR_SECTIONS,
	PR_SHAPE,
} from "./sanctioned.ts";
export {
	type ChangeSize,
	detectShapeViolations,
	usesDepth,
} from "./shape.ts";
export { formatShapeBlock } from "./shape-block.ts";
