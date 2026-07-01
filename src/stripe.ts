import type { Database as DatabaseSync } from "better-sqlite3";
import { getConfig } from "./db.js";

export async function executeConnector(db: DatabaseSync, action: Record<string, unknown>) {
  const configuredKey = process.env.STRIPE_SECRET_KEY || getConfig(db, "stripe_secret_key");
  const testModeKey = configuredKey?.startsWith("sk_test_") ? configuredKey : null;

  if (!testModeKey) {
    return mockExecution(action);
  }

  const payload = new URLSearchParams();
  payload.set("amount", formatStripeAmount(action.amount));
  payload.set("currency", String(action.currency ?? "usd").toLowerCase());
  payload.set("confirm", "true");
  payload.set("payment_method", "pm_card_visa");
  payload.set("payment_method_types[0]", "card");
  payload.set("description", buildDescription(action));
  payload.set("metadata[permit_action_id]", String(action.id ?? ""));
  payload.set("metadata[permit_source_agent]", String(action.source_agent ?? "hermes"));
  payload.set("metadata[permit_requester]", String(action.requester ?? "unknown"));
  payload.set("metadata[permit_vendor]", String(action.vendor ?? "unknown"));
  payload.set("metadata[permit_reason]", truncate(String(action.reason ?? "No reason provided"), 500));
  payload.set("metadata[permit_recurring]", String(Boolean(action.recurring)));

  try {
    const response = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        authorization: `Bearer ${testModeKey}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: payload
    });
    const data = await readStripeResponse(response);

    if (response.ok && typeof data.id === "string") {
      return {
        connector: "stripe_test" as const,
        external_id: data.id,
        status: "succeeded" as const,
        error: null
      };
    }

    const message = typeof data.error?.message === "string"
      ? data.error.message
      : `Stripe request failed with status ${response.status}`;

    if (response.status >= 500 || response.status === 429) {
      return mockExecution(action, `Stripe test API unavailable, used mock fallback: ${message}`);
    }

    return {
      connector: "stripe_test" as const,
      external_id: typeof data.id === "string" ? data.id : null,
      status: "failed" as const,
      error: message
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return mockExecution(action, `Stripe test API unreachable, used mock fallback: ${message}`);
  }
}

function mockExecution(action: Record<string, unknown>, error: string | null = null) {
  return {
    connector: "mock" as const,
    external_id: `mock_${Date.now()}_${action.id}`,
    status: "succeeded" as const,
    error
  };
}

function formatStripeAmount(amount: unknown) {
  const value = Number(amount ?? 0);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Stripe execution requires a positive amount.");
  }
  return String(Math.max(1, Math.round(value * 100)));
}

function buildDescription(action: Record<string, unknown>) {
  return truncate(
    `Permit action #${String(action.id ?? "unknown")} for ${String(action.vendor ?? "unknown vendor")}: ${String(action.reason ?? "No reason provided")}`,
    500
  );
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

async function readStripeResponse(response: Response) {
  const text = await response.text();
  if (!text) return {} as Record<string, any>;
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return { error: { message: text } } as Record<string, any>;
  }
}
