import { randomAgentName } from "./name-gen.js";
import { ANCESTOR_ID_PATTERN } from "./registry-contracts.js";

/**
 * Allocate short human-readable child names (max, zoe, kai…) instead of
 * machine IDs. Reserve every ancestor name and every name already used in
 * this process, so nested workers never collide in the shared tree display.
 */
export class AgentNameAllocator {
	private readonly reserved = new Set<string>();

	constructor(seeds: readonly string[]) {
		for (const name of seeds) {
			if (ANCESTOR_ID_PATTERN.test(name)) this.reserved.add(name);
		}
	}

	next(): string {
		const name = randomAgentName(this.reserved);
		this.reserved.add(name);
		return name;
	}
}
