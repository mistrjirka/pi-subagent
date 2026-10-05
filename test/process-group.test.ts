import assert from "node:assert/strict";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RpcClient } from "../rpc-client.js";

it("signals a surviving process group after its leader exits", { skip: process.platform === "win32" }, async () => {
	const script = `
 const {spawn} = require("node:child_process");
 const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: ["ignore", "inherit", "inherit"]});
 child.on("spawn", () => {
  process.stdout.write(JSON.stringify({type:"response",id:"c1",command:"get_state",success:true,data:{pid:child.pid}})+"\\n");
  setTimeout(() => process.exit(0), 30);
 });
 `;
	const client = new RpcClient({ command: process.execPath, args: ["-e", script], cwd: process.cwd() });
	let childPid: number | undefined;
	try {
		const result = await client.sendCommand({ type: "get_state" });
		if (!result.success) throw new Error(result.error);
		childPid = (result.data as { pid: number }).pid;
		const deadline = Date.now() + 2000;
		while (client.exitCode === null && Date.now() < deadline) await delay(10);
		assert.equal(client.exitCode, 0);
		assert.equal(client.isClosed, false, "the grandchild still holds stdout open");
		client.kill("SIGTERM");
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				client.waitForExit(),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error("surviving process group did not exit")), 2000);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		assert.equal(client.isClosed, true);
	} finally {
		if (childPid) {
			try {
				process.kill(childPid, "SIGKILL");
			} catch {}
		}
		client.kill("SIGKILL");
	}
});
