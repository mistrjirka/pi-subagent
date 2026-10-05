import { StringDecoder } from "node:string_decoder";

/** Bounded JSONL framing. Oversize frames fail explicitly; following frames survive. */
export class JsonlFramer {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";
	private dropping = false;

	constructor(
		private readonly onLine: (line: string) => void,
		private readonly onOverflow: (error: Error) => void,
		private readonly maxChars = 1024 * 1024,
	) {}

	write(chunk: Buffer): void {
		const text = this.decoder.write(chunk);
		let start = 0;
		while (start < text.length) {
			const end = text.indexOf("\n", start);
			const part = text.slice(start, end < 0 ? text.length : end);
			if (!this.dropping) {
				if (this.buffer.length + part.length > this.maxChars) {
					this.buffer = "";
					this.dropping = true;
					this.onOverflow(new Error(`RPC frame exceeds ${this.maxChars} characters.`));
				} else {
					this.buffer += part;
				}
			}
			if (end < 0) break;
			if (!this.dropping) this.onLine(this.buffer);
			this.buffer = "";
			this.dropping = false;
			start = end + 1;
		}
	}
}
