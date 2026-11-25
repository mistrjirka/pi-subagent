/** Pure wait-window policy: one default for waits and fallback supervision. */
export const DEFAULT_WAIT_TIMEOUT_SECONDS = 150;

export function resolveWaitTimeoutSeconds(requested: number | undefined): number {
	return requested ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
}
