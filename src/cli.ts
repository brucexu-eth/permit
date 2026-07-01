#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  allConfig,
  approvalDecision,
  createDraft,
  DB_PATH,
  decidePolicy,
  migrate,
  openDb,
  seedDefaults,
  validateToken,
  writeReceipt
} from "./db.js";
import { startServer } from "./server.js";
import { executeConnector } from "./stripe.js";

const command = process.argv[2] ?? "help";

async function main() {
  if (command === "init") return init();
  if (command === "start") return start();
  if (command === "status") return status();
  if (command === "doctor") return doctor();
  if (command === "seed") return await seedDemo();
  if (command === "install" && process.argv[3] === "hermes") return installHermes();
  return help();
}

function init() {
  const db = openDb();
  migrate(db);
  seedDefaults(db);
  mkdirSync(".permit", { recursive: true });
  const envPath = join(".permit", ".env.example");
  if (!existsSync(envPath)) {
    writeFileSync(envPath, "PORT=4733\nSTRIPE_SECRET_KEY=sk_test_optional\n");
  }
  console.log(`Permit initialized at ${DB_PATH}`);
}

function start() {
  init();
  startServer();
}

function status() {
  if (!existsSync(DB_PATH)) {
    console.log("Permit is not initialized. Run: permit init");
    return;
  }
  const db = openDb();
  const cfg = allConfig(db);
  const counts = {
    users: count(db, "users"),
    policies: count(db, "policies"),
    action_drafts: count(db, "action_drafts"),
    approval_requests: count(db, "approval_requests"),
    audit_receipts: count(db, "audit_receipts")
  };
  console.log(JSON.stringify({ database: DB_PATH, config: redact(cfg), counts }, null, 2));
}

function doctor() {
  const checks = [
    ["Node >= 20", Number(process.versions.node.split(".")[0]) >= 20],
    ["SQLite database initialized", existsSync(DB_PATH)],
    ["Stripe is test mode or mock", !process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.startsWith("sk_test_")],
    ["Hermes hook installed", existsSync(join(".permit", "hermes-hook.js"))]
  ];
  for (const [name, ok] of checks) {
    console.log(`${ok ? "ok" : "warn"}  ${name}`);
  }
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.startsWith("sk_test_")) {
    process.exitCode = 1;
  }
}

async function seedDemo() {
  const db = openDb();
  migrate(db);
  seedDefaults(db);
  db.prepare("DELETE FROM audit_receipts").run();
  db.prepare("DELETE FROM executions").run();
  db.prepare("DELETE FROM approval_tokens").run();
  db.prepare("DELETE FROM approval_requests").run();
  db.prepare("DELETE FROM policy_decisions").run();
  db.prepare("DELETE FROM action_drafts").run();
  db.prepare("DELETE FROM audit_events").run();
  db.prepare("DELETE FROM users").run();
  db.prepare("INSERT INTO users (name, role, telegram_user_id) VALUES ('Bruce', 'admin', NULL)").run();
  db.prepare("INSERT INTO users (name, role, telegram_user_id) VALUES ('CFO', 'cfo', '12345')").run();
  db.prepare("INSERT INTO config (key, value, updated_at) VALUES ('company_name', 'Acme AI Ops', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run();
  db.prepare("INSERT INTO config (key, value, updated_at) VALUES ('admin_name', 'Bruce', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run();
  db.prepare("INSERT INTO config (key, value, updated_at) VALUES ('cfo_telegram_user_id', '12345', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run();
  db.prepare("INSERT INTO config (key, value, updated_at) VALUES ('default_currency', 'USD', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP").run();

  const figma = createDraft(db, { source_agent: "hermes", requester: "Bruce", action_type: "saas_purchase", vendor: "Figma", amount: 75, currency: "USD", recurring: true, reason: "Buy 5 Figma seats for the design team" });
  decidePolicy(db, Number(figma?.id));

  const cursor = createDraft(db, { source_agent: "hermes", requester: "Alice", action_type: "saas_purchase", vendor: "Cursor", amount: 40, currency: "USD", recurring: true, reason: "Open a Cursor team subscription for engineering" });
  decidePolicy(db, Number(cursor?.id));
  const cursorApproval = db.prepare("SELECT id FROM approval_requests WHERE action_id = ?").get(Number(cursor?.id)) as { id: number };
  const approved = approvalDecision(db, cursorApproval.id, "approved", "12345", "Demo approval");
  if (!approved.token || !validateToken(db, Number(cursor?.id), approved.token)) throw new Error("Seed approval token failed");
  const cursorExec = await executeConnector(db, cursor!);
  const cursorExecution = db.prepare("INSERT INTO executions (action_id, connector, status, external_id, error) VALUES (?, ?, ?, ?, ?)").run(Number(cursor?.id), cursorExec.connector, cursorExec.status, cursorExec.external_id, cursorExec.error);
  db.prepare("UPDATE action_drafts SET status = 'executed' WHERE id = ?").run(Number(cursor?.id));
  writeReceipt(db, Number(cursor?.id), Number(cursorExecution.lastInsertRowid));

  const vendor = createDraft(db, { source_agent: "hermes", requester: "Bruce", action_type: "vendor_payment", vendor: "unknown", amount: 1200, currency: "USD", recurring: false, reason: "Pay a new vendor invoice without prior vendor record" });
  decidePolicy(db, Number(vendor?.id));

  console.log("Seeded demo data: pending Figma approval, executed Cursor approval, blocked unknown-vendor payment.");
}

function installHermes() {
  init();
  const hook = `// Permit Hermes hook simulation.
// Hermes should call POST http://localhost:4733/api/actions/draft before any financial action.
// Sensitive execution must call POST /api/actions/:id/execute with a Permit approval token.
export async function submitPermitDraft(fetchImpl, draft) {
  const response = await fetchImpl("http://localhost:4733/api/actions/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source_agent: "hermes", ...draft })
  });
  return response.json();
}

export async function executeWithPermit(fetchImpl, actionId, approvalToken) {
  if (!approvalToken) throw new Error("Permit approval token required");
  const response = await fetchImpl(\`http://localhost:4733/api/actions/\${actionId}/execute\`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approval_token: approvalToken })
  });
  return response.json();
}
`;
  writeFileSync(join(".permit", "hermes-hook.js"), hook);

  const hermesHome = process.env.HERMES_HOME ?? join(homedir(), ".hermes");
  const pluginDir = join(hermesHome, "plugins", "permit");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "plugin.yaml"), `name: permit
version: "0.1.0"
description: Permit approval and audit tools for Hermes financial actions
provides_tools:
  - permit_request_financial_action
  - permit_execute_approved_action
`);
  writeFileSync(join(pluginDir, "__init__.py"), `"""Permit Hermes plugin: request approval before financial actions."""

import json
import urllib.error
import urllib.request

PERMIT_BASE_URL = "http://127.0.0.1:4733"

try:
    from gateway.session_context import get_session_env
except Exception:
    def get_session_env(name, default=""):
        return default


def _post(path, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        PERMIT_BASE_URL + path,
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return {"success": False, "error": body, "status": exc.code}


def _origin_fields(params, kwargs):
    origin = {}
    session_platform = get_session_env("HERMES_SESSION_PLATFORM", "")
    session_chat_id = get_session_env("HERMES_SESSION_CHAT_ID", "")
    session_thread_id = get_session_env("HERMES_SESSION_THREAD_ID", "")
    if session_platform:
        origin["source_platform"] = str(session_platform)
    if session_chat_id:
        origin["source_chat_id"] = str(session_chat_id)
    if session_thread_id:
        origin["source_thread_id"] = str(session_thread_id)
    for container_name in ("source", "context", "message", "event"):
        container = kwargs.get(container_name)
        if isinstance(container, dict):
            if not origin.get("source_chat_id"):
                chat_id = container.get("chat_id") or container.get("channel_id")
                if chat_id:
                    origin["source_chat_id"] = str(chat_id)
            if not origin.get("source_thread_id"):
                thread_id = container.get("thread_id") or container.get("message_thread_id")
                if thread_id:
                    origin["source_thread_id"] = str(thread_id)
            if not origin.get("source_platform") and container.get("platform"):
                origin["source_platform"] = str(container["platform"])
    if not origin.get("source_chat_id"):
        chat_id = str(params.get("source_chat_id", ""))
        if _valid_chat_id(origin.get("source_platform", "telegram"), chat_id):
            origin["source_chat_id"] = chat_id
    if not origin.get("source_thread_id"):
        thread_id = str(params.get("source_thread_id", ""))
        if thread_id:
            origin["source_thread_id"] = str(thread_id)
    if not origin.get("source_platform"):
        platform = str(params.get("source_platform", ""))
        if platform:
            origin["source_platform"] = platform
    if not origin.get("source_platform"):
        origin["source_platform"] = "telegram"
    return origin


def _valid_chat_id(platform, value):
    if not value:
        return False
    if str(platform).lower() != "telegram":
        return True
    text = str(value)
    return text.lstrip("-").isdigit()


def _approval_summary(result):
    draft = result.get("draft") if isinstance(result.get("draft"), dict) else {}
    approval = result.get("approval") if isinstance(result.get("approval"), dict) else {}
    decision = result.get("decision") if isinstance(result.get("decision"), dict) else {}
    notification = result.get("approval_notification") if isinstance(result.get("approval_notification"), dict) else {}
    return {
        "success": "error" not in result,
        "action_id": draft.get("id"),
        "approval_id": approval.get("id"),
        "approval_status": approval.get("status", "pending"),
        "policy_decision": decision.get("result"),
        "cfo_dm_sent": notification.get("sent"),
        "next_step": "Tell the requester that CFO approval is pending. Do not ask the requester for an approval token; Permit will send the internal token to Hermes and execute automatically after CFO approval.",
    }


def _execution_summary(result):
    summary = result.get("summary") if isinstance(result.get("summary"), dict) else {}
    connector = result.get("connector") if isinstance(result.get("connector"), dict) else {}
    status = summary.get("status") or connector.get("status") or "unknown"
    external_id = summary.get("stripe_or_external_id") or connector.get("external_id") or ""
    receipt_id = summary.get("receipt_id") or result.get("receipt_id")
    amount = summary.get("amount")
    currency = summary.get("currency") or ""
    vendor = summary.get("vendor") or "unknown vendor"
    action_id = summary.get("action_id") or result.get("action_id")
    message = (
        f"Purchase execution {status}: {vendor} for {amount} {currency}. "
        f"Action #{action_id}, receipt #{receipt_id}."
    )
    if external_id:
        message += f" Stripe/test external id: {external_id}."
    if summary.get("reason"):
        message += f" Reason: {summary.get('reason')}."
    return {
        "success": "error" not in result and status == "succeeded",
        "message": message,
        "action_id": action_id,
        "vendor": vendor,
        "amount": amount,
        "currency": currency,
        "recurring": summary.get("recurring"),
        "requester": summary.get("requester"),
        "reason": summary.get("reason"),
        "execution_status": status,
        "connector": summary.get("connector") or connector.get("connector"),
        "stripe_or_external_id": external_id,
        "receipt_id": receipt_id,
        "error": summary.get("error") or connector.get("error"),
    }


def register(ctx):
    request_schema = {
        "name": "permit_request_financial_action",
        "description": "Create a Permit approval request before Hermes performs a payment, procurement, SaaS subscription, invoice, or other sensitive financial action. Use this before execution, not after. After creating the request, tell the requester that CFO approval is pending; do not ask the requester for an approval token because Permit sends that internal token to Hermes automatically after approval.",
        "parameters": {
            "type": "object",
            "properties": {
                "requester": {"type": "string"},
                "action_type": {"type": "string", "description": "payment, saas_purchase, vendor_payment, subscription, etc."},
                "vendor": {"type": "string"},
                "amount": {"type": "number"},
                "currency": {"type": "string", "default": "USD"},
                "recurring": {"type": "boolean", "default": False},
                "reason": {"type": "string"},
            },
            "required": ["requester", "action_type", "vendor", "amount", "reason"],
        },
    }

    def handle_request(params, **kwargs):
        result = _post("/api/actions/draft", {"source_agent": "hermes", **params, **_origin_fields(params, kwargs)})
        return json.dumps(_approval_summary(result), ensure_ascii=False)

    ctx.register_tool(
        name="permit_request_financial_action",
        toolset="permit",
        schema=request_schema,
        handler=handle_request,
        description="Request Permit approval for a financial action.",
    )

    execute_schema = {
        "name": "permit_execute_approved_action",
        "description": "Internal Permit webhook follow-up: execute a Permit action only after CFO approval. Requires the one-time approval token delivered by Permit, not by the requester. Never ask the requester to provide this token.",
        "parameters": {
            "type": "object",
            "properties": {
                "action_id": {"type": "integer"},
                "approval_token": {"type": "string"},
            },
            "required": ["action_id", "approval_token"],
        },
    }

    def handle_execute(params, **kwargs):
        del kwargs
        action_id = int(params["action_id"])
        result = _post(f"/api/actions/{action_id}/execute", {"approval_token": params["approval_token"]})
        return json.dumps(_execution_summary(result), ensure_ascii=False)

    ctx.register_tool(
        name="permit_execute_approved_action",
        toolset="permit",
        schema=execute_schema,
        handler=handle_execute,
        description="Execute an approved Permit financial action.",
    )
`);
  console.log("Hermes hook simulation written to .permit/hermes-hook.js");
  console.log(`Hermes plugin written to ${pluginDir}`);
  console.log("Enable it with: hermes plugins enable permit && restart Hermes/gateway");
}

function help() {
  console.log(`Permit MVP

Usage:
  permit init
  permit start
  permit status
  permit doctor
  permit seed
  permit install hermes

During development:
  npm run permit -- <command>
`);
}

function count(db: ReturnType<typeof openDb>, table: string) {
  return (db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count;
}

function redact(cfg: Record<string, string>) {
  return Object.fromEntries(Object.entries(cfg).map(([key, value]) => [key, key.includes("secret") ? "[redacted]" : value]));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
