export { violationSignature } from "../gate/index.js";
export { formatSectionBlock } from "./block.js";
export {
	detectSectionViolations,
	type SectionViolation,
} from "./detect.js";
export {
	type SectionGateConfig,
	type SectionGateDecision,
	sectionGateDecision,
} from "./gate.js";
export { ISSUE_SECTIONS, PR_SECTIONS } from "./sanctioned.js";
