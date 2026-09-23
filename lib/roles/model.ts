/**
 * The minimum shape of a model this package's own role derivation
 * needs, decoupled from pi-ai's full `Model<Api>` so it stays testable
 * against plain fixtures rather than the live registry.
 */
export interface RoleModelCost {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface RoleModel {
	readonly id: string;
	readonly provider: string;
	readonly cost: RoleModelCost;
}
