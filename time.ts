/**
 * pi-subagent — system-local wall-clock stamps for supervision transcripts.
 *
 * The supervision transcript (agent_wait / agent_inspect output) is read by the
 * parent model, so every line carries a short local-time stamp: the machine's
 * own wall clock plus a relative age (`17:42:03 · 12s ago`). All rendering
 * uses local date getters — never `toISOString`, `toUTCString` or `getUTC*` —
 * so the clock matches what `date` on this machine prints, not UTC.
 */

/** Zero-padded two-digit local field. */
function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

/**
 * System-local wall clock for an epoch-ms instant: `HH:MM:SS` (24-hour) when
 * the instant falls on the same local calendar day as `now`, otherwise
 * `MM-DD HH:MM` so a cross-day entry stays unambiguous.
 */
export function formatClockTime(ms: number, now: number = Date.now()): string {
	const at = new Date(ms);
	const ref = new Date(now);
	const sameDay =
		at.getFullYear() === ref.getFullYear() && at.getMonth() === ref.getMonth() && at.getDate() === ref.getDate();
	if (sameDay) {
		return `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`;
	}
	return `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/**
 * Short relative age for an epoch-ms instant: `just now` (under ~5 s),
 * then `12s ago` / `3m ago` / `2h ago` / `3d ago`. Future instants (clock
 * skew) read as `just now` rather than a negative age.
 */
export function formatAgo(ms: number, now: number = Date.now()): string {
	const diffMs = Math.max(0, now - ms);
	if (diffMs < 5_000) return "just now";
	const seconds = Math.floor(diffMs / 1_000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** One terse stamp for transcript lines: `HH:MM:SS · 12s ago`. */
export function formatStamp(ms: number, now: number = Date.now()): string {
	return `${formatClockTime(ms, now)} · ${formatAgo(ms, now)}`;
}
