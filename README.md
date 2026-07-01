# Permit

Permit is an installable approval and audit layer for enterprise AI agents.

It lets agents request real financial or business actions without holding unchecked authority. The first demo integrates Hermes Agent, Telegram approvals, and Stripe test-mode payments to show a controlled procurement flow end to end.

## Hackathon pitch

AI agents can now earn, spend, and run operations. That creates a new enterprise problem: the agent may be capable of buying SaaS seats, paying vendors, or provisioning tools, but finance and security teams still need policy, approval, credential separation, and auditability before they let it touch money.

Permit is the finance control plane for Hermes Agent. Hermes can detect a procurement intent, draft the action, and ask Permit for approval. Permit applies policy, DMs the CFO, blocks execution until approval, and then lets Hermes execute with a one-time internal approval token. The requester never sees the token. The final result goes back to the original Telegram group, and Permit writes a tamper-evident receipt with policy version, Stripe external ID, and hash-chain fields.

For the hackathon demo, Stripe is not mocked when a test key is configured: approved purchases create real Stripe **test-mode** succeeded payments using the saved `sk_test_...` key and Stripe test card payment method. If no test key is configured, Permit falls back to mock execution so the approval/audit workflow still works locally.

## Product thesis

Agent payments are cool. Auditing is the blocker.

Enterprises will not let agents buy SaaS, pay invoices, open subscriptions, or move funds unless every action has:

- policy enforcement before execution;
- human approval for risky actions;
- credential separation so the agent cannot bypass finance controls;
- tamper-evident audit receipts;
- a reviewable history for finance, security, and operations.

Permit provides that control layer.

## Why enterprises need this

Without a control layer, an AI agent that can spend money is either too dangerous to deploy or too limited to be useful. Permit separates four responsibilities that enterprise finance teams care about:

- **Intent:** Hermes can understand and draft the procurement request.
- **Policy:** Permit decides whether the request is auto-allowed, approval-required, or blocked.
- **Approval:** the CFO approves or rejects from Telegram without giving the agent broad authority.
- **Execution and audit:** Hermes executes only after Permit issues an internal one-time token, and Permit records a receipt that finance/security can review later.

This is the difference between a demo agent that can call Stripe and a viable business operations agent that a company could actually supervise.

## MVP scope

The MVP is intentionally small:

1. A CLI that initializes Permit, starts a local web app, and installs Hermes hooks.
2. A SQLite-backed web app for setup, approvals, policies, and audit history.
3. A Hermes hook that intercepts procurement/payment intents before execution.
4. Telegram DM approvals for the configured CFO/admin Telegram ID.
5. Stripe test-mode execution after approval, with mock execution as fallback.
6. Append-only audit receipts with policy version and hash-chain fields.

## Demo flow

```text
1. Admin runs Permit CLI.
2. Permit starts a local web app.
3. Admin configures company, CFO Telegram ID, Stripe test key, and finance policies.
4. CLI installs hooks into the local Hermes Agent.
5. A user asks Hermes in Telegram: "Buy 5 Figma seats for the design team."
6. Hermes detects a financial/procurement action and submits an action draft to Permit.
7. Permit checks policy and blocks execution until approval.
8. CFO receives a Telegram DM with Approve / Reject buttons.
9. If rejected, Permit sends "No purchase was executed" back to the original requester chat.
10. If approved, Permit sends an internal one-time approval token to Hermes through the local webhook.
11. Hermes executes the purchase through Stripe test mode and replies to the original Telegram group with a receipt-style summary.
12. Permit stores an append-only audit receipt visible in the web app.
```


## Non-goals for the hackathon MVP

- No full enterprise RBAC suite.
- No large SaaS dashboard.
- No real production payments by default.
- No generic agent platform.
- No reliance on Stripe Link CLI / agent wallet availability.

## Why this matters

Agents are moving from chat into business execution. The bottleneck is no longer whether an agent can call an API. The bottleneck is whether a company can safely authorize, supervise, and audit that action.

Permit turns risky agent actions into controlled workflows.

## Repository status

This repository now includes a minimal local MVP implementation in TypeScript/Node.

## Install on a Hermes server

Requires Node 20 or newer. Install the published package on the server where Hermes runs:

```bash
npm install -g hermes-premit
permit init
permit install hermes
HOST=127.0.0.1 PORT=4733 permit start
```

The installed command is still `permit`.

Open a tunnel from your laptop if the server is remote:

```bash
ssh -L 4733:127.0.0.1:4733 user@your-server
```

Then open:

```text
http://localhost:4733
```

Useful commands:

```bash
permit status
permit doctor
permit seed
```

`STRIPE_SECRET_KEY=sk_test_... permit start` enables the Stripe test connector path. You can also save the key in the Setup page. With a test key configured, approved purchases create confirmed Stripe test-mode PaymentIntents using `pm_card_visa`. If no Stripe test key is set, Permit uses the mock connector while preserving the same approval and audit flow.

## Develop locally

Requires Node 20 or newer. The app uses `better-sqlite3` for SQLite so it works on the default Node 20 runtime.

```bash
npm run permit -- init
npm run permit -- install hermes
npm run permit -- seed
npm run permit -- start
```

Open:

```text
http://localhost:4733
```

Useful commands:

```bash
npm run permit -- status
npm run permit -- doctor
npm run permit -- seed
npm run check
npm run build
```

## Demo API flow

Create an action draft from a Hermes-style hook:

```bash
curl -s http://localhost:4733/api/actions/draft \
  -H 'content-type: application/json' \
  -d '{
    "source_agent": "hermes",
    "requester": "Bruce",
    "action_type": "saas_purchase",
    "vendor": "Figma",
    "amount": 75,
    "currency": "USD",
    "recurring": true,
    "reason": "Buy 5 Figma seats for the design team"
  }'
```

Approve with the configured CFO Telegram ID:

```bash
curl -s http://localhost:4733/api/approvals/1/approve \
  -H 'content-type: application/json' \
  -d '{"telegram_user_id":"<configured CFO Telegram ID>","note":"approved"}'
```

Execute only with the returned one-time Permit token:

```bash
curl -s http://localhost:4733/api/actions/1/execute \
  -H 'content-type: application/json' \
  -d '{"approval_token":"permit_..."}'
```

Receipts are visible at `/audit` and `/receipts/:id`. Each receipt includes `policy_version`, `previous_hash`, and `receipt_hash`.

For the Telegram/Hermes demo, the requester should not handle this token manually. The token is an internal Permit-to-Hermes execution credential used by the webhook after CFO approval.

## Hermes Agent integration

See [`docs/HERMES_INTEGRATION.md`](docs/HERMES_INTEGRATION.md).

Short version:

```bash
permit install hermes
hermes plugins enable permit
hermes gateway restart # if using Telegram
```

Then ask Hermes to use Permit before procurement/payment actions. The MVP plugin registers `permit_request_financial_action` and `permit_execute_approved_action`.
