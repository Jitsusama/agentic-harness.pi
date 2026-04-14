/**
 * Guardian contract, registration and redirect formatting.
 *
 * Public entry point for building command guardians.
 * Downstream packages import from here to implement the
 * detect → parse → review pipeline.
 */

export { formatRedirectBlock } from "./redirect.js";
export { registerGuardian } from "./register.js";
export { ALLOW, type CommandGuardian, type GuardianResult } from "./types.js";
