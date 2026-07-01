import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database, { type Database as DatabaseSync } from "better-sqlite3";

export const DATA_DIR = ".permit";
export const DB_PATH = join(DATA_DIR, "permit.sqlite");

export type DraftInput = {
  source_agent?: string;
  requester?: string;
  action_type?: string;
  vendor?: string;
  amount?: number;
  currency?: string;
  recurring?: boolean;
  reason?: string;
  raw_request?: string;
};

export type Decision = {
  result: "allow" | "require_approval" | "block";
  reasons: string[];
  policyId: number;
  policyVersion: number;
};

type PolicyRules = {
  autoAllowMockUnderUsd: number;
  requireApprovalForStripe: boolean;
  requireApprovalForRecurring: boolean;
  blockUnknownVendorAboveUsd: number;
  blockWithoutCfoTelegramId: boolean;
};

export type FundsDirection = "inflow" | "outflow";

export function openDb(path = DB_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'cfo', 'requester')),
      telegram_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
      rules_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS action_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_agent TEXT NOT NULL,
      requester TEXT NOT NULL,
      action_type TEXT NOT NULL,
      vendor TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      recurring INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      raw_request TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft', 'approval_required', 'approved', 'rejected', 'simulate_only', 'blocked', 'executed', 'failed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS policy_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_id INTEGER NOT NULL REFERENCES action_drafts(id),
      policy_id INTEGER NOT NULL REFERENCES policies(id),
      policy_version INTEGER NOT NULL,
      result TEXT NOT NULL CHECK(result IN ('allow', 'require_approval', 'block')),
      reasons_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_id INTEGER NOT NULL REFERENCES action_drafts(id),
      approver_user_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'simulate_only', 'expired')),
      decision_note TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS approval_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_id INTEGER NOT NULL REFERENCES action_drafts(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_id INTEGER NOT NULL REFERENCES action_drafts(id),
      connector TEXT NOT NULL CHECK(connector IN ('stripe_test', 'mock')),
      status TEXT NOT NULL CHECK(status IN ('not_started', 'started', 'succeeded', 'failed')),
      external_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_id INTEGER NOT NULL REFERENCES action_drafts(id),
      receipt_json TEXT NOT NULL,
      previous_hash TEXT,
      receipt_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      action_id INTEGER,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export function seedDefaults(db: DatabaseSync) {
  const active = db.prepare("SELECT id FROM policies WHERE status = 'active' LIMIT 1").get();
  if (!active) {
    db.prepare("INSERT INTO policies (version, name, status, rules_json) VALUES (?, ?, 'active', ?)").run(
      1,
      "Default finance controls",
      JSON.stringify({
        autoAllowMockUnderUsd: 10,
        requireApprovalForStripe: true,
        requireApprovalForRecurring: true,
        blockUnknownVendorAboveUsd: 500,
        blockWithoutCfoTelegramId: true
      })
    );
  }
  setConfig(db, "default_currency", getConfig(db, "default_currency") ?? "USD");
}

export function setConfig(db: DatabaseSync, key: string, value: string) {
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
}

export function getConfig(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function allConfig(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM config ORDER BY key").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function ensureUser(db: DatabaseSync, name: string, role: "admin" | "cfo" | "requester", telegramId?: string) {
  const existing = telegramId
    ? db.prepare("SELECT id FROM users WHERE telegram_user_id = ? AND role = ?").get(telegramId, role)
    : db.prepare("SELECT id FROM users WHERE name = ? AND role = ?").get(name, role);
  if (existing) return (existing as { id: number }).id;
  const result = db.prepare("INSERT INTO users (name, role, telegram_user_id) VALUES (?, ?, ?)").run(name, role, telegramId ?? null);
  return Number(result.lastInsertRowid);
}

export function createDraft(db: DatabaseSync, input: DraftInput) {
  const amount = Number(input.amount ?? 0);
  const recurring = input.recurring ? 1 : 0;
  const risk = recurring || amount >= 100 ? "high" : amount >= 10 ? "medium" : "low";
  const result = db.prepare(`
    INSERT INTO action_drafts
      (source_agent, requester, action_type, vendor, amount, currency, recurring, reason, risk_level, raw_request, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
  `).run(
    input.source_agent ?? "hermes",
    input.requester ?? "unknown",
    input.action_type ?? "payment",
    input.vendor ?? "unknown",
    amount,
    (input.currency ?? getConfig(db, "default_currency") ?? "USD").toUpperCase(),
    recurring,
    input.reason ?? "No reason provided",
    risk,
    input.raw_request ?? JSON.stringify(input)
  );
  const id = Number(result.lastInsertRowid);
  logEvent(db, "draft.created", input.source_agent ?? "hermes", id, input);
  return getDraft(db, id);
}

export function getDraft(db: DatabaseSync, id: number) {
  return db.prepare("SELECT * FROM action_drafts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

export function decidePolicy(db: DatabaseSync, actionId: number): Decision {
  const action = getDraft(db, actionId);
  if (!action) throw new Error("Action draft not found");
  const policy = db.prepare("SELECT * FROM policies WHERE status = 'active' ORDER BY version DESC LIMIT 1").get() as Record<string, unknown>;
  const rules = parsePolicyRules(policy.rules_json);
  const cfg = allConfig(db);
  const amount = Number(action.amount);
  const recurring = Boolean(action.recurring);
  const vendor = String(action.vendor ?? "").toLowerCase();
  const hasCfo = Boolean(cfg.cfo_telegram_user_id);
  const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY || cfg.stripe_secret_key);
  const reasons: string[] = [];
  let result: Decision["result"] = "allow";

  if (rules.blockWithoutCfoTelegramId && !hasCfo) {
    result = "block";
    reasons.push("No CFO Telegram ID is configured.");
  }
  if (vendor === "unknown" && amount > rules.blockUnknownVendorAboveUsd) {
    result = "block";
    reasons.push(`Unknown vendor payments above ${rules.blockUnknownVendorAboveUsd} USD are blocked.`);
  }
  if (rules.requireApprovalForStripe && stripeConfigured) {
    result = result === "block" ? result : "require_approval";
    reasons.push("Real Stripe test execution requires CFO approval.");
  }
  if (rules.requireApprovalForRecurring && recurring) {
    result = result === "block" ? result : "require_approval";
    reasons.push("Recurring subscriptions require CFO approval.");
  }
  if (!stripeConfigured && amount >= rules.autoAllowMockUnderUsd) {
    result = result === "block" ? result : "require_approval";
    reasons.push(`Mock actions at or above ${rules.autoAllowMockUnderUsd} USD require CFO approval.`);
  }
  if (result === "allow") {
    reasons.push(stripeConfigured ? "Active policy allows this Stripe test action." : `Mock action under ${rules.autoAllowMockUnderUsd} USD is auto-allowed.`);
  }

  db.prepare(`
    INSERT INTO policy_decisions (action_id, policy_id, policy_version, result, reasons_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(actionId, Number(policy.id), Number(policy.version), result, JSON.stringify(reasons));

  const status = result === "allow" ? "approved" : result === "block" ? "blocked" : "approval_required";
  db.prepare("UPDATE action_drafts SET status = ? WHERE id = ?").run(status, actionId);

  if (result === "require_approval") {
    const cfo = db.prepare("SELECT id FROM users WHERE role = 'cfo' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
    db.prepare("INSERT INTO approval_requests (action_id, approver_user_id, status) VALUES (?, ?, 'pending')").run(actionId, cfo?.id ?? null);
  }
  if (result === "allow") {
    issueToken(db, actionId);
  }
  logEvent(db, `policy.${result}`, "permit", actionId, { reasons });
  return { result, reasons, policyId: Number(policy.id), policyVersion: Number(policy.version) };
}

function parsePolicyRules(value: unknown): PolicyRules {
  const defaults: PolicyRules = {
    autoAllowMockUnderUsd: 10,
    requireApprovalForStripe: true,
    requireApprovalForRecurring: true,
    blockUnknownVendorAboveUsd: 500,
    blockWithoutCfoTelegramId: true
  };
  try {
    const parsed = JSON.parse(String(value ?? "{}")) as Partial<PolicyRules>;
    return {
      autoAllowMockUnderUsd: Number(parsed.autoAllowMockUnderUsd ?? defaults.autoAllowMockUnderUsd),
      requireApprovalForStripe: Boolean(parsed.requireApprovalForStripe ?? defaults.requireApprovalForStripe),
      requireApprovalForRecurring: Boolean(parsed.requireApprovalForRecurring ?? defaults.requireApprovalForRecurring),
      blockUnknownVendorAboveUsd: Number(parsed.blockUnknownVendorAboveUsd ?? defaults.blockUnknownVendorAboveUsd),
      blockWithoutCfoTelegramId: Boolean(parsed.blockWithoutCfoTelegramId ?? defaults.blockWithoutCfoTelegramId)
    };
  } catch {
    return defaults;
  }
}

export function issueToken(db: DatabaseSync, actionId: number) {
  const token = `permit_${randomBytes(24).toString("hex")}`;
  const tokenHash = hash(token);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO approval_tokens (action_id, token_hash, expires_at) VALUES (?, ?, ?)").run(actionId, tokenHash, expiresAt);
  logEvent(db, "token.issued", "permit", actionId, { expires_at: expiresAt });
  return token;
}

export function validateToken(db: DatabaseSync, actionId: number, token: string) {
  const row = db.prepare(`
    SELECT * FROM approval_tokens
    WHERE action_id = ? AND token_hash = ? AND used_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(actionId, hash(token)) as { id: number; expires_at: string } | undefined;
  if (!row) return false;
  if (new Date(row.expires_at).getTime() <= Date.now()) return false;
  db.prepare("UPDATE approval_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
  return true;
}

export function latestTokenForDemo(db: DatabaseSync, actionId: number) {
  return db.prepare(`
    SELECT id, expires_at, used_at FROM approval_tokens
    WHERE action_id = ? ORDER BY id DESC LIMIT 1
  `).get(actionId);
}

export function approvalDecision(db: DatabaseSync, approvalId: number, status: "approved" | "rejected" | "simulate_only", actorTelegramId: string | null, note = "") {
  const cfg = allConfig(db);
  if (!cfg.cfo_telegram_user_id) {
    logEvent(db, "approval.unauthorized", actorTelegramId ? `telegram:${actorTelegramId}` : "unknown", null, { approval_id: approvalId, reason: "missing_cfo_telegram_user_id" });
    throw new Error("No CFO Telegram ID is configured.");
  }
  if (actorTelegramId !== cfg.cfo_telegram_user_id) {
    logEvent(db, "approval.unauthorized", `telegram:${actorTelegramId}`, null, { approval_id: approvalId, expected: cfg.cfo_telegram_user_id });
    throw new Error("Only the configured CFO Telegram ID can decide approvals.");
  }
  const approval = db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(approvalId) as Record<string, unknown> | undefined;
  if (!approval) throw new Error("Approval not found");
  if (approval.status !== "pending") throw new Error(`Approval is already ${approval.status}`);
  db.prepare("UPDATE approval_requests SET status = ?, decision_note = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, note, approvalId);
  const actionStatus = status === "approved" ? "approved" : status;
  db.prepare("UPDATE action_drafts SET status = ? WHERE id = ?").run(actionStatus, Number(approval.action_id));
  const token = status === "approved" || status === "simulate_only" ? issueToken(db, Number(approval.action_id)) : null;
  logEvent(db, `approval.${status}`, actorTelegramId ? `telegram:${actorTelegramId}` : "web", Number(approval.action_id), { approval_id: approvalId, note });
  return { approval, token };
}

export function writeReceipt(db: DatabaseSync, actionId: number, executionId: number) {
  const action = getDraft(db, actionId);
  const decision = db.prepare("SELECT * FROM policy_decisions WHERE action_id = ? ORDER BY id DESC LIMIT 1").get(actionId);
  const approval = db.prepare("SELECT * FROM approval_requests WHERE action_id = ? ORDER BY id DESC LIMIT 1").get(actionId);
  const execution = db.prepare("SELECT * FROM executions WHERE id = ?").get(executionId);
  const previous = db.prepare("SELECT receipt_hash FROM audit_receipts ORDER BY id DESC LIMIT 1").get() as { receipt_hash: string } | undefined;
  const direction = deriveFundsDirection(action);
  const receipt = {
    action,
    policy_decision: decision,
    approval,
    execution,
    audit_summary: {
      direction,
      connector: summarizeExecutionField(execution, "connector"),
      external_id: summarizeExecutionField(execution, "external_id"),
      action_id: actionId
    },
    policy_version: Number((decision as Record<string, unknown> | undefined)?.policy_version ?? 0),
    previous_hash: previous?.receipt_hash ?? null
  };
  const receiptJson = stableJson(receipt);
  const receiptHash = hash(receiptJson);
  const result = db.prepare(`
    INSERT INTO audit_receipts (action_id, receipt_json, previous_hash, receipt_hash)
    VALUES (?, ?, ?, ?)
  `).run(actionId, receiptJson, previous?.receipt_hash ?? null, receiptHash);
  logEvent(db, "receipt.created", "permit", actionId, { receipt_id: Number(result.lastInsertRowid), receipt_hash: receiptHash });
  return Number(result.lastInsertRowid);
}

export function deriveFundsDirection(action: Record<string, unknown> | undefined): FundsDirection {
  const actionType = String(action?.action_type ?? "").toLowerCase();
  const reason = String(action?.reason ?? "").toLowerCase();
  const vendor = String(action?.vendor ?? "").toLowerCase();
  const haystack = `${actionType} ${reason} ${vendor}`;
  const inflowHints = [
    "reimbursement_in",
    "income",
    "invoice_collection",
    "receive_payment",
    "received_payment",
    "payment_received",
    "incoming",
    "funds in",
    "refund received",
    "received refund",
    "vendor refund"
  ];

  if (inflowHints.some((hint) => haystack.includes(hint))) {
    return "inflow";
  }

  return "outflow";
}

function summarizeExecutionField(execution: unknown, key: string) {
  return execution && typeof execution === "object"
    ? String((execution as Record<string, unknown>)[key] ?? "")
    : "";
}

export function logEvent(db: DatabaseSync, eventType: string, actor: string, actionId: number | null, details: unknown) {
  db.prepare("INSERT INTO audit_events (event_type, actor, action_id, details_json) VALUES (?, ?, ?, ?)").run(
    eventType,
    actor,
    actionId,
    JSON.stringify(details)
  );
}

export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, sortValue(val)]));
  }
  return value;
}
