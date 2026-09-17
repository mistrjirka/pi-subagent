/** Pure wait-window policy: omitted agent_wait timeout defaults to 3 minutes. */
export const DEFAULT_WAIT_TIMEOUT_SECONDS = 180;

export function resolveWaitTimeoutSeconds(requested: number | undefined): number {
	return requested ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
}
