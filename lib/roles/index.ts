/**
 * Deriving model roles from what a provider's registry actually
 * exposes: which models are archaic, and which of the rest are
 * premium, primary and light.
 */

export { type ArchaicFinding, findArchaic } from "./archaic.js";
export { deriveRoles, type RoleAssignment } from "./derive.js";
export type { RoleModel, RoleModelCost } from "./model.js";
