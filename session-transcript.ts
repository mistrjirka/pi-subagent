import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

/** Read persisted entries a page at a time, without a giant RPC response. */
export class SessionEntryCursor {
	private fileKey = "";
	private offset = 0;
	private readonly positions = new Map<string, number>();
	private scannedTo = 0;

	read(path: string, maxMessages: number): { entries: unknown[]; hasMore: boolean } {
		const fd = openSync(path, "r");
		try {
			const stat = fstatSync(fd);
			const key = `${path}:${stat.dev}:${stat.ino}`;
			if (key !== this.fileKey || stat.size < this.offset) {
				this.fileKey = key;
				this.offset = 0;
			}
			this.positions.clear();
			this.scannedTo = this.offset;
			const entries: unknown[] = [];
			const parts: Buffer[] = [];
			let lineBytes = 0;
			let messages = 0;
			let position = this.offset;
			const stopAt = Math.min(stat.size, this.offset + MAX_SCAN_BYTES);
			while (position < stopAt && messages < maxMessages) {
				const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, stopAt - position));
				const count = readSync(fd, buffer, 0, buffer.length, position);
				if (!count) break;
				let start = 0;
				while (start < count && messages < maxMessages) {
					const newline = buffer.indexOf(10, start);
					const end = newline < 0 || newline >= count ? count : newline;
					const part = buffer.subarray(start, end);
					parts.push(Buffer.from(part));
					lineBytes += part.length;
					if (lineBytes > MAX_SCAN_BYTES) throw new Error("Persisted session entry exceeds 8 MiB.");
					if (end === count) break;
					const text = Buffer.concat(parts, lineBytes).toString("utf8");
					parts.length = 0;
					lineBytes = 0;
					this.scannedTo = position + end + 1;
					if (text.trim()) {
						const entry: unknown = JSON.parse(text);
						if (entry && typeof entry === "object") {
							const record = entry as Record<string, unknown>;
							if (record.type !== "session") {
								entries.push(entry);
								if (typeof record.id === "string") this.positions.set(record.id, this.scannedTo);
								if (record.type === "message") messages++;
							}
						}
					}
					start = end + 1;
				}
				position += count;
			}
			if (lineBytes && stopAt < stat.size && this.scannedTo === this.offset) {
				throw new Error("Persisted session entry exceeds the bounded 8 MiB read window.");
			}
			return { entries, hasMore: this.scannedTo < stat.size && (messages >= maxMessages || stopAt < stat.size) };
		} finally {
			closeSync(fd);
		}
	}

	commit(entryId?: string): void {
		const position = entryId ? this.positions.get(entryId) : this.scannedTo;
		if (position !== undefined) this.offset = position;
	}
}
