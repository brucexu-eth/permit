import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseSync } from "better-sqlite3";
import { allConfig, approvalDecision, logEvent } from "./db.js";

export type TelegramSendResult = {
  sent: boolean;
  method: "none" | "telegram_bot";
  reason?: string;
  status?: number;
};

export function mockTelegramMessage(db: DatabaseSync, approvalId: number, action: Record<string, unknown>) {
  const cfg = allConfig(db);
  const cfo = cfg.cfo_telegram_user_id || "not configured";
  const text = [
    "Permit approval required",
    "",
    `CFO Telegram ID: ${cfo}`,
    `Approval: ${approvalId}`,
    `Requester: ${action.requester}`,
    `Agent: ${action.source_agent}`,
    `Vendor: ${action.vendor}`,
    `Amount: ${action.amount} ${action.currency}`,
    `Reason: ${action.reason}`,
    "",
    `Mock commands: /approve ${approvalId}, /reject ${approvalId}`
  ].join("\n");
  logEvent(db, "telegram.mock_sent", "permit", Number(action.id), { approval_id: approvalId, cfo_telegram_user_id: cfo });
  return text;
}

export function handleTelegramCommand(db: DatabaseSync, senderTelegramId: string, command: string) {
  const [verb, idText, ...rest] = command.trim().split(/\s+/);
  const approvalId = Number(idText);
  if (!approvalId || !["/approve", "/reject"].includes(verb)) {
    throw new Error("Expected /approve <id> or /reject <id>");
  }
  if (verb === "/approve") return approvalDecision(db, approvalId, "approved", senderTelegramId, rest.join(" "));
  return approvalDecision(db, approvalId, "rejected", senderTelegramId, rest.join(" ") || "Rejected via Telegram mock");
}

export async function sendCfoApprovalDm(db: DatabaseSync, approvalId: number, action: Record<string, unknown>): Promise<TelegramSendResult> {
  const cfg = allConfig(db);
  const cfoTelegramId = cfg.cfo_telegram_user_id;
  if (!cfoTelegramId) {
    logEvent(db, "telegram.approval_dm_skipped", "permit", Number(action.id), { approval_id: approvalId, reason: "missing_cfo_telegram_user_id" });
    return { sent: false, method: "none", reason: "missing_cfo_telegram_user_id" };
  }

  const botToken = telegramBotToken();
  if (!botToken) {
    logEvent(db, "telegram.approval_dm_skipped", "permit", Number(action.id), { approval_id: approvalId, reason: "missing_telegram_bot_token" });
    return { sent: false, method: "none", reason: "missing_telegram_bot_token" };
  }

  const raw = parseRawRequest(action.raw_request);
  const sourceChat = raw.source_chat_id || raw.telegram_chat_id || raw.chat_id || "";
  const text = [
    "Permit approval required",
    "",
    `Approval ID: ${approvalId}`,
    `Vendor: ${action.vendor}`,
    `Amount: ${action.amount} ${action.currency}`,
    `Recurring: ${Number(action.recurring) ? "yes" : "no"}`,
    `Requester: ${action.requester}`,
    `Reason: ${action.reason}`,
    sourceChat ? `Feedback target: Telegram chat ${sourceChat}` : "",
    "",
    "Use the buttons below to approve or reject."
  ].filter(Boolean).join("\n");

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: cfoTelegramId,
        text,
        reply_markup: {
          inline_keyboard: [[
            { text: "Approve", callback_data: `permit:approve:${approvalId}` },
            { text: "Reject", callback_data: `permit:reject:${approvalId}` }
          ]]
        }
      })
    });
    const body = await response.text();
    const sent = response.status >= 200 && response.status < 300;
    logEvent(db, sent ? "telegram.approval_dm_sent" : "telegram.approval_dm_failed", "permit", Number(action.id), {
      approval_id: approvalId,
      status: response.status,
      error_preview: sent ? undefined : body.slice(0, 300)
    });
    return { sent, method: "telegram_bot", status: response.status, reason: sent ? undefined : body.slice(0, 300) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent(db, "telegram.approval_dm_failed", "permit", Number(action.id), { approval_id: approvalId, error: message });
    return { sent: false, method: "telegram_bot", reason: message };
  }
}

export async function sendTelegramMessage(
  db: DatabaseSync,
  actionId: number,
  chatId: string,
  text: string,
  threadId?: string
): Promise<TelegramSendResult> {
  if (!chatId) {
    logEvent(db, "telegram.feedback_skipped", "permit", actionId, { reason: "missing_chat_id" });
    return { sent: false, method: "none", reason: "missing_chat_id" };
  }

  const botToken = telegramBotToken();
  if (!botToken) {
    logEvent(db, "telegram.feedback_skipped", "permit", actionId, { reason: "missing_telegram_bot_token" });
    return { sent: false, method: "none", reason: "missing_telegram_bot_token" };
  }

  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (threadId) body.message_thread_id = threadId;

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const responseBody = await response.text();
    const sent = response.status >= 200 && response.status < 300;
    logEvent(db, sent ? "telegram.feedback_sent" : "telegram.feedback_failed", "permit", actionId, {
      status: response.status,
      chat_id: chatId,
      thread_id: threadId || undefined,
      error_preview: sent ? undefined : responseBody.slice(0, 300)
    });
    return { sent, method: "telegram_bot", status: response.status, reason: sent ? undefined : responseBody.slice(0, 300) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent(db, "telegram.feedback_failed", "permit", actionId, { chat_id: chatId, thread_id: threadId || undefined, error: message });
    return { sent: false, method: "telegram_bot", reason: message };
  }
}

function telegramBotToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    const env = readFileSync(join(process.env.HERMES_HOME ?? join(homedir(), ".hermes"), ".env"), "utf8");
    const match = env.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
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
