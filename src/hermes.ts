import { createHmac } from "node:crypto";
import type { Database as DatabaseSync } from "better-sqlite3";
import { allConfig, getDraft, logEvent } from "./db.js";
import { sendTelegramMessage } from "./telegram.js";

export type HermesApprovalNotification = {
  sent: boolean;
  method: "none" | "webhook" | "telegram_bot";
  reason?: string;
  status?: number;
};

export async function notifyHermesApproval(
  db: DatabaseSync,
  actionId: number,
  approvalId: number,
  status: "approved" | "rejected",
  token: string | null
) {
  const cfg = allConfig(db);
  const action = getDraft(db, actionId);
  if (!action) return { sent: false, method: "none", reason: "action_not_found" } satisfies HermesApprovalNotification;
  const raw = parseRawRequest(action.raw_request);
  const sourcePlatform = raw.source_platform || "telegram";
  const sourceChatId = firstValidChatId(sourcePlatform, raw.source_chat_id, raw.telegram_chat_id, raw.chat_id, cfg.cfo_telegram_user_id);
  const sourceThreadId = raw.source_thread_id || raw.telegram_thread_id || raw.message_thread_id || "";

  if (status === "rejected") {
    return await sendTelegramMessage(
      db,
      actionId,
      sourceChatId,
      [
        "Permit approval rejected",
        "",
        `Action ID: ${actionId}`,
        `Approval ID: ${approvalId}`,
        `Vendor: ${action.vendor}`,
        `Amount: ${action.amount} ${action.currency}`,
        `Requester: ${action.requester}`,
        `Reason: ${action.reason}`,
        "",
        "No purchase was executed."
      ].join("\n"),
      sourceThreadId
    );
  }

  if (!cfg.hermes_webhook_url || !cfg.hermes_webhook_secret) {
    logEvent(db, "hermes.notify_skipped", "permit", actionId, { approval_id: approvalId, reason: "webhook_not_configured" });
    return { sent: false, method: "none", reason: "webhook_not_configured" } satisfies HermesApprovalNotification;
  }

  const payload = {
    event_type: `permit.approval.${status}`,
    action_id: Number(action.id),
    approval_id: approvalId,
    approval_status: status,
    approval_token: token,
    vendor: action.vendor,
    amount: action.amount,
    currency: action.currency,
    recurring: Boolean(action.recurring),
    requester: action.requester,
    reason: action.reason,
    source_platform: sourcePlatform,
    source_chat_id: sourceChatId,
    source_thread_id: sourceThreadId
  };
  const body = JSON.stringify(payload);
  const signature = "sha256=" + createHmac("sha256", cfg.hermes_webhook_secret).update(body).digest("hex");

  try {
    const response = await fetch(cfg.hermes_webhook_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-event": payload.event_type,
        "x-request-id": `permit-${payload.action_id}-${approvalId}-${Date.now()}`
      },
      body
    });
    const text = await response.text();
    const ok = response.status >= 200 && response.status < 300;
    logEvent(db, ok ? "hermes.webhook_sent" : "hermes.webhook_failed", "permit", payload.action_id, {
      approval_id: approvalId,
      status: response.status,
      body_preview: text.slice(0, 300)
    });
    return { sent: ok, method: "webhook", status: response.status, reason: ok ? undefined : text.slice(0, 300) } satisfies HermesApprovalNotification;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent(db, "hermes.webhook_failed", "permit", Number(action.id), { approval_id: approvalId, error: message });
    return { sent: false, method: "webhook", reason: message } satisfies HermesApprovalNotification;
  }
}

function firstValidChatId(platform: string, ...values: Array<string | undefined>) {
  for (const value of values) {
    if (value && validChatId(platform, value)) return value;
  }
  return "";
}

function validChatId(platform: string, value: string) {
  if (platform.toLowerCase() !== "telegram") return Boolean(value);
  return /^-?\d+$/.test(value);
}

function parseRawRequest(value: unknown): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, val]) => [key, String(val)]));
  } catch {
    return {};
  }
}
