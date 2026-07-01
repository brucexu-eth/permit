import assert from "node:assert/strict";
import { once } from "node:events";
import { unlinkSync } from "node:fs";
import { get } from "node:http";
import {
  approvalDecision,
  createDraft,
  decidePolicy,
  ensureUser,
  issueToken,
  migrate,
  openDb,
  seedDefaults,
  setConfig,
  validateToken,
  writeReceipt
} from "../src/db.ts";
import { startServer } from "../src/server.ts";
import { executeConnector } from "../src/stripe.ts";

function freshDb(path: string) {
  try {
    unlinkSync(path);
  } catch {
    // Nothing to clean.
  }
  const db = openDb(path);
  migrate(db);
  seedDefaults(db);
  setConfig(db, "cfo_telegram_user_id", "12345");
  setConfig(db, "default_currency", "USD");
  ensureUser(db, "CFO", "cfo", "12345");
  return db;
}

async function approvedExecution(db: ReturnType<typeof openDb>, draft: Record<string, unknown>) {
  const connector = await executeConnector(db, draft);
  const execution = db.prepare("INSERT INTO executions (action_id, connector, status, external_id) VALUES (?, ?, ?, ?)").run(
    Number(draft.id),
    connector.connector,
    connector.status,
    connector.external_id
  );
  return writeReceipt(db, Number(draft.id), Number(execution.lastInsertRowid));
}

async function readUrl(url: string) {
  return await new Promise<string>((resolve, reject) => {
    get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

const db = freshDb("/tmp/permit-e2e.sqlite");

const draft = createDraft(db, {
  source_agent: "hermes",
  requester: "Bruce",
  action_type: "saas_purchase",
  vendor: "Figma",
  amount: 75,
  currency: "USD",
  recurring: true,
  reason: "Buy 5 Figma seats"
});

const decision = decidePolicy(db, Number(draft?.id));
assert.equal(decision.result, "require_approval");
assert.equal(decision.policyVersion, 1);

const approval = db.prepare("SELECT * FROM approval_requests WHERE action_id = ?").get(Number(draft?.id)) as { id: number };
assert.ok(approval.id);

assert.throws(() => approvalDecision(db, approval.id, "approved", "99999", "wrong sender"), /configured CFO Telegram ID/);

const approved = approvalDecision(db, approval.id, "approved", "12345", "approved");
assert.ok(approved.token);
assert.equal(validateToken(db, Number(draft?.id), approved.token!), true);
assert.equal(validateToken(db, Number(draft?.id), approved.token!), false);

const receiptId = await approvedExecution(db, draft!);
const receipt = db.prepare("SELECT * FROM audit_receipts WHERE id = ?").get(receiptId) as { receipt_json: string; receipt_hash: string; previous_hash: string | null };
const payload = JSON.parse(receipt.receipt_json);
assert.equal(payload.policy_version, 1);
assert.equal(receipt.previous_hash, null);
assert.ok(receipt.receipt_hash);

const second = createDraft(db, {
  source_agent: "hermes",
  requester: "Alice",
  action_type: "payment",
  vendor: "Cursor",
  amount: 20,
  currency: "USD",
  recurring: false,
  reason: "One-time tool reimbursement"
});
decidePolicy(db, Number(second?.id));
issueToken(db, Number(second?.id));
const secondReceiptId = await approvedExecution(db, second!);
const secondReceipt = db.prepare("SELECT * FROM audit_receipts WHERE id = ?").get(secondReceiptId) as { previous_hash: string | null };
assert.equal(secondReceipt.previous_hash, receipt.receipt_hash);

const customerRefund = createDraft(db, {
  source_agent: "hermes",
  requester: "Alice",
  action_type: "refund",
  vendor: "Stripe dispute",
  amount: 20,
  currency: "USD",
  recurring: false,
  reason: "Customer refund for duplicate charge"
});
decidePolicy(db, Number(customerRefund?.id));
issueToken(db, Number(customerRefund?.id));
const customerRefundReceiptId = await approvedExecution(db, customerRefund!);
const customerRefundReceipt = db.prepare("SELECT * FROM audit_receipts WHERE id = ?").get(customerRefundReceiptId) as { receipt_json: string };
const customerRefundPayload = JSON.parse(customerRefundReceipt.receipt_json);
assert.equal(customerRefundPayload.audit_summary.direction, "outflow");
assert.equal(customerRefundPayload.audit_summary.connector, "mock");
assert.match(String(customerRefundPayload.audit_summary.external_id ?? ""), /^mock_/);

const vendorRefund = createDraft(db, {
  source_agent: "hermes",
  requester: "Alice",
  action_type: "vendor_refund",
  vendor: "Figma",
  amount: 20,
  currency: "USD",
  recurring: false,
  reason: "Vendor refund received for unused seats"
});
decidePolicy(db, Number(vendorRefund?.id));
issueToken(db, Number(vendorRefund?.id));
const vendorRefundReceiptId = await approvedExecution(db, vendorRefund!);
const vendorRefundReceipt = db.prepare("SELECT * FROM audit_receipts WHERE id = ?").get(vendorRefundReceiptId) as { receipt_json: string };
const vendorRefundPayload = JSON.parse(vendorRefundReceipt.receipt_json);
assert.equal(vendorRefundPayload.audit_summary.direction, "inflow");

const blocked = createDraft(db, {
  source_agent: "hermes",
  requester: "Bruce",
  action_type: "vendor_payment",
  vendor: "unknown",
  amount: 1200,
  currency: "USD",
  recurring: false,
  reason: "Pay unverified vendor"
});
const blockedDecision = decidePolicy(db, Number(blocked?.id));
assert.equal(blockedDecision.result, "block");
assert.match(blockedDecision.reasons.join("\n"), /Unknown vendor/);

const tiny = createDraft(db, {
  source_agent: "hermes",
  requester: "Bruce",
  action_type: "payment",
  vendor: "Coffee",
  amount: 5,
  currency: "USD",
  recurring: false,
  reason: "Tiny mock payment"
});
const tinyDecision = decidePolicy(db, Number(tiny?.id));
assert.equal(tinyDecision.result, "allow");
const tinyToken = db.prepare("SELECT used_at FROM approval_tokens WHERE action_id = ?").get(Number(tiny?.id));
assert.ok(tinyToken);

const policyDb = freshDb("/tmp/permit-policy-rules.sqlite");
setConfig(policyDb, "stripe_secret_key", "sk_test_policy_rules_demo");
policyDb.prepare("UPDATE policies SET rules_json = ? WHERE status = 'active'").run(JSON.stringify({
  autoAllowMockUnderUsd: 50,
  requireApprovalForStripe: false,
  requireApprovalForRecurring: false,
  blockUnknownVendorAboveUsd: 500,
  blockWithoutCfoTelegramId: true
}));
const policyDraft = createDraft(policyDb, {
  source_agent: "hermes",
  requester: "Policy Tester",
  action_type: "vendor_payment",
  vendor: "Linear",
  amount: 20,
  currency: "USD",
  recurring: false,
  reason: "Policy override should allow this Stripe test action"
});
const policyDecision = decidePolicy(policyDb, Number(policyDraft?.id));
assert.equal(policyDecision.result, "allow");
assert.match(policyDecision.reasons.join(" "), /allows this Stripe test action/);

const stripeDraft = createDraft(db, {
  source_agent: "hermes",
  requester: "Bruce",
  action_type: "vendor_payment",
  vendor: "Linear",
  amount: 12.34,
  currency: "USD",
  recurring: false,
  reason: "Pay Linear test invoice"
});

const originalFetch = globalThis.fetch;
const stripeRequest = { url: "", method: "", authorization: null as string | null, body: "" };
let stripeRequestCaptured = false;

await withEnv("STRIPE_SECRET_KEY", "sk_test_live_permit_demo", async () => {
  globalThis.fetch = (async (input, init) => {
    stripeRequest.url = String(input);
    stripeRequest.method = String(init?.method ?? "GET");
    stripeRequest.authorization = init?.headers instanceof Headers
      ? init.headers.get("authorization")
      : Array.isArray(init?.headers)
        ? new Headers(init.headers).get("authorization")
        : new Headers(init?.headers as HeadersInit | undefined).get("authorization");
    stripeRequest.body = String(init?.body ?? "");
    stripeRequestCaptured = true;
    return new Response(JSON.stringify({ id: "pi_test_123", object: "payment_intent" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  const stripeExecution = await executeConnector(db, stripeDraft!);
  assert.equal(stripeExecution.connector, "stripe_test");
  assert.equal(stripeExecution.status, "succeeded");
  assert.equal(stripeExecution.external_id, "pi_test_123");
});

globalThis.fetch = originalFetch;
assert.equal(stripeRequestCaptured, true);
assert.equal(stripeRequest.url, "https://api.stripe.com/v1/payment_intents");
assert.equal(stripeRequest.method, "POST");
assert.equal(stripeRequest.authorization, "Bearer sk_test_live_permit_demo");

const stripeParams = new URLSearchParams(stripeRequest.body);
assert.equal(stripeParams.get("amount"), "1234");
assert.equal(stripeParams.get("currency"), "usd");
assert.equal(stripeParams.get("confirm"), "true");
assert.equal(stripeParams.get("payment_method"), "pm_card_visa");
assert.equal(stripeParams.get("payment_method_types[0]"), "card");
assert.equal(stripeParams.get("metadata[permit_action_id]"), String(stripeDraft?.id));
assert.equal(stripeParams.get("metadata[permit_vendor]"), "Linear");
assert.match(stripeParams.get("description") ?? "", /Permit action/);

const uiDbPath = "/tmp/permit-ui.sqlite";
const uiDb = freshDb(uiDbPath);
setConfig(uiDb, "stripe_secret_key", "sk_test_1234567890_secret");
const server = startServer(0, uiDbPath);
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
const html = await readUrl(`http://127.0.0.1:${address.port}/setup`);
server.close();
assert.doesNotMatch(html, /sk_test_1234567890_secret/);
assert.match(html, /Saved key hidden\. Enter a new sk_test_\.\.\. to replace it\./);
assert.match(html, /A Stripe test key is already saved and hidden in this form\./);
assert.match(html, /Hermes webhook URL/);
assert.match(html, /Hermes webhook secret/);
assert.doesNotMatch(html, /Telegram bot token/);
assert.doesNotMatch(html, /CFO contact/);
assert.doesNotMatch(html, /Hermes notify target/);

const auditDbPath = "/tmp/permit-audit-ui.sqlite";
const auditDb = freshDb(auditDbPath);
const auditDraft = createDraft(auditDb, {
  source_agent: "hermes",
  requester: "Bruce",
  action_type: "vendor_payment",
  vendor: "Linear",
  amount: 42,
  currency: "USD",
  recurring: false,
  reason: "Pay vendor"
});
decidePolicy(auditDb, Number(auditDraft?.id));
issueToken(auditDb, Number(auditDraft?.id));
const auditReceiptId = await approvedExecution(auditDb, auditDraft!);

const auditRefund = createDraft(auditDb, {
  source_agent: "hermes",
  requester: "Bruce",
  action_type: "vendor_refund",
  vendor: "Figma",
  amount: 12,
  currency: "USD",
  recurring: false,
  reason: "Vendor refund received"
});
decidePolicy(auditDb, Number(auditRefund?.id));
issueToken(auditDb, Number(auditRefund?.id));
const auditRefundReceiptId = await approvedExecution(auditDb, auditRefund!);

const auditServer = startServer(0, auditDbPath);
await once(auditServer, "listening");
const auditAddress = auditServer.address();
assert.ok(auditAddress && typeof auditAddress === "object");
const auditHtml = await readUrl(`http://127.0.0.1:${auditAddress.port}/audit`);
const receiptHtml = await readUrl(`http://127.0.0.1:${auditAddress.port}/receipts/${auditReceiptId}`);
const refundHtml = await readUrl(`http://127.0.0.1:${auditAddress.port}/receipts/${auditRefundReceiptId}`);
auditServer.close();

assert.match(auditHtml, /Funds out/);
assert.match(auditHtml, /Funds in/);
assert.match(auditHtml, /mock_/);
assert.match(auditHtml, /Linear/);
assert.match(receiptHtml, /Direction/);
assert.match(receiptHtml, /Funds out/);
assert.match(receiptHtml, /Connector/);
assert.match(receiptHtml, /ExternalID/);
assert.match(refundHtml, /Funds in/);

console.log("e2e ok");
