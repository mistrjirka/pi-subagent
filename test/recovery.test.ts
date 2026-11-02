import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { RecoveryStore } from "../recovery.js";

const roots: string[] = [];
function fixture(): { root: string; cwd: string; sessions: string; file: string; store: RecoveryStore } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-recovery-test-"));
	roots.push(root);
	const cwd = path.join(root, "repo");
	const sessions = path.join(root, "sessions");
	fs.mkdirSync(cwd);
	fs.mkdirSync(sessions);
	execFileSync("git", ["init", "-q", cwd]);
	execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd });
	execFileSync(
		"git",
		["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "init"],
		{ cwd },
	);
	const file = path.join(sessions, "saved.jsonl");
	fs.writeFileSync(file, '{"type":"session","version":3,"id":"test"}\n');
	const store = new RecoveryStore(path.join(root, "agent"), sessions);
	return { root, cwd, sessions, file, store };
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function create(f: ReturnType<typeof fixture>) {
	return f.store.create({
		cwd: f.cwd,
		profile: "implementer",
		label: "policy deployment",
		model: "openai/gpt-6.1-sol",
		thinking: "medium",
		sessionPath: f.file,
	});
}

describe("persistent subagent recovery metadata", () => {
	it("records scoped metadata without duplicating transcripts and keeps a live lease", () => {
		const f = fixture();
		const r = create(f);
		assert.equal(r.profile, "implementer");
		assert.equal(r.branch, "feature");
		assert.equal(r.status, "active");
		assert.equal(r.ownerPid, process.pid);
		assert.equal(f.store.list(f.cwd).length, 1);
		assert.equal(f.store.list(f.cwd)[0]?.available, false);
		assert.equal(f.store.list(f.cwd)[0]?.record.sessionPath, f.file);
		assert.equal(fs.readFileSync(f.file, "utf8"), '{"type":"session","version":3,"id":"test"}\n');
		const serialized = fs.readFileSync(path.join(f.root, "agent", "subagent-recovery", `${r.id}.json`), "utf8");
		assert.ok(!serialized.includes("access_token"));
		assert.throws(() => f.store.resume(r.id, f.cwd, "implementer", r.model), /already owned/);
		f.store.suspendAll();
		assert.equal(f.store.list(f.cwd)[0]?.available, true);
	});

	it("resumes one saved worker after the owning process exits, never automatically rerunning work", () => {
		const f = fixture();
		const r = create(f);
		f.store.suspendAll();
		const restored = f.store.resume(r.id, f.cwd, "implementer", r.model);
		assert.equal(restored.id, r.id);
		assert.equal(restored.sessionPath, f.file);
		assert.equal(restored.status, "active");
		assert.equal(f.store.list(f.cwd)[0]?.available, false);
		f.store.suspend(restored.id);
		assert.equal(f.store.list(f.cwd)[0]?.available, true);
	});

	it("refuses a different branch, project, role, or model, and leaves the record recoverable", () => {
		const f = fixture();
		const r = create(f);
		f.store.suspendAll();
		assert.throws(() => f.store.resume(r.id, f.cwd, "explore", r.model), /role/);
		assert.throws(() => f.store.resume(r.id, f.cwd, "implementer", "doppelclaude/claude-sonnet-5-5"), /requires/);
		const elsewhere = path.join(f.root, "other");
		fs.mkdirSync(elsewhere);
		assert.throws(() => f.store.resume(r.id, elsewhere, "implementer", r.model), /another project/);
		execFileSync("git", ["checkout", "-q", "-b", "other"], { cwd: f.cwd });
		assert.equal(f.store.list(f.cwd).length, 0);
		assert.throws(() => f.store.resume(r.id, f.cwd, "implementer", r.model), /Git branch/);
		execFileSync("git", ["checkout", "-q", "feature"], { cwd: f.cwd });
		assert.equal(f.store.list(f.cwd)[0]?.available, true);
	});

	it("explicit stop permanently retires its recovery id", () => {
		const f = fixture();
		const r = create(f);
		f.store.retire(r.id);
		assert.equal(f.store.list(f.cwd).length, 0);
		assert.throws(() => f.store.resume(r.id, f.cwd, "implementer", r.model), /explicitly stopped/);
	});

	it("rejects external or symlinked transcripts and a tampered record", () => {
		const f = fixture();
		const outside = path.join(f.root, "outside.jsonl");
		fs.writeFileSync(outside, '{"type":"session"}\n');
		assert.throws(
			() => f.store.create({ cwd: f.cwd, profile: "implementer", label: "bad", model: "p/m", sessionPath: outside }),
			/configured subagent session directory/,
		);
		const link = path.join(f.sessions, "linked.jsonl");
		fs.symlinkSync(f.file, link);
		assert.throws(
			() => f.store.create({ cwd: f.cwd, profile: "implementer", label: "bad", model: "p/m", sessionPath: link }),
			/regular file/,
		);
		const r = create(f);
		f.store.suspendAll();
		const file = path.join(f.root, "agent", "subagent-recovery", `${r.id}.json`);
		const text = JSON.parse(fs.readFileSync(file, "utf8"));
		text.cwd = path.join(f.root, "forged");
		fs.writeFileSync(file, JSON.stringify(text));
		assert.equal(f.store.list(f.cwd).length, 0);
		assert.throws(() => f.store.resume(r.id, f.cwd, "implementer", r.model), /another project/);
	});

	it("rejects an active same-process lease even after a second store object is created", () => {
		const f = fixture();
		const r = create(f);
		const second = new RecoveryStore(path.join(f.root, "agent"), f.sessions);
		assert.equal(second.list(f.cwd)[0]?.available, false);
		assert.throws(() => second.resume(r.id, f.cwd, "implementer", r.model), /already owned/);
		f.store.suspend(r.id);
		assert.equal(second.list(f.cwd)[0]?.available, true);
		const next = second.resume(r.id, f.cwd, "implementer", r.model);
		assert.equal(next.id, r.id);
		second.suspendAll();
	});

	it("prevents concurrent stale-lease reclamation", () => {
		const f = fixture();
		const r = create(f);
		const lease = path.join(f.root, "agent", "subagent-recovery", "leases", `${r.id}.lock`);
		fs.writeFileSync(lease, JSON.stringify({ pid: 2_147_483_647 }));
		const guard = `${lease}.reclaiming`;
		fs.mkdirSync(guard);
		const second = new RecoveryStore(path.join(f.root, "agent"), f.sessions);
		assert.throws(() => second.resume(r.id, f.cwd, "implementer", r.model), /Another Pi process is reclaiming/);
		fs.rmdirSync(guard);
		const restored = second.resume(r.id, f.cwd, "implementer", r.model);
		assert.equal(restored.id, r.id);
		second.suspendAll();
	});

	it("recovers stale process leases after an unclean shutdown", () => {
		const f = fixture();
		const r = create(f);
		// Simulate a crashed parent: its original metadata remains active but
		// a process id no longer exists. The file is retained.
		const lease = path.join(f.root, "agent", "subagent-recovery", "leases", `${r.id}.lock`);
		fs.writeFileSync(lease, JSON.stringify({ pid: 2_147_483_647 }));
		assert.equal(f.store.list(f.cwd)[0]?.available, true);
		const next = f.store.resume(r.id, f.cwd, "implementer", r.model);
		assert.equal(next.id, r.id);
		f.store.suspendAll();
	});
});
