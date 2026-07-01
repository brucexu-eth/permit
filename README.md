# Permit

Permit is an installable approval and audit layer for Hermes and other AI agents that need to perform financial or high-risk business actions.

Agents can draft the work. Permit owns the approval state, execution gate, payment connector, and audit receipt.

Permit integrates with Stripe for real-world procurement and payment workflows while keeping the demo test-mode by default. For enterprise-grade security and sandboxed execution, the recommended deployment direction is to run Permit alongside Hermes on NVIDIA NemoClaw.

Building a business with Hermes is incredibly easy. But production use needs a control layer: approvals, auditability, credential isolation, and secure execution. Permit is a small side project built for that gap.

Origin: [Bruce Xu's X post about Permit](https://x.com/brucexu_eth/status/2072142120669053395).

## Why Permit

AI agents are moving from chat into business execution: buying SaaS seats, paying vendors, opening subscriptions, issuing refunds, and provisioning tools. The blocker is no longer whether an agent can call an API. The blocker is whether a company can safely authorize, supervise, and audit that action.

Permit gives Hermes a finance control layer:

- **Approval before execution**: sensitive actions are paused until the configured CFO/admin approves.
- **Credential separation**: Hermes never needs the Stripe secret key or other payment credentials.
- **Token-gated execution**: sensitive tools must receive a one-time Permit approval token before they run.
- **Explicit approver identity**: Telegram approval checks the configured CFO/admin sender ID.
- **Real-world procurement path**: Stripe integration supports payment/procurement demos while staying test-mode by default.
- **Secure deployment story**: recommended deployment on NVIDIA NemoClaw for enterprise-grade security and sandboxed execution.
- **Tamper-evident receipts**: each receipt includes policy version and hash-chain fields.
- **Local-first install**: the MVP runs with Node, SQLite, a local web app, and a Hermes plugin.

The core point: Permit does not ask people to trust a prompt. It adds a tool-level approval and audit boundary around the agent.

## Hermes Flow

```text
Telegram user asks Hermes to buy/pay/refund
        |
        v
Hermes calls Permit before execution
        |
        v
Permit checks policy and creates an approval request
        |
        +----> CFO/admin approves or rejects in Telegram or the web app
        |
        v
Permit sends a one-time approval token to Hermes
        |
        v
Hermes executes through Permit's Stripe test or mock connector
        |
        v
Permit writes an audit receipt with policy and hash-chain fields
```

The requester never handles the approval token. It is an internal Permit-to-Hermes execution credential.

For enterprise deployments, Permit is designed to run beside Hermes in a controlled execution environment. NVIDIA NemoClaw is the recommended direction for a hardened, sandboxed runtime; this repository keeps the MVP local-first and does not require NemoClaw to run the demo.

## Hermes Integration

Permit installs a Hermes user plugin with two tools:

- `permit_request_financial_action` creates a Permit approval request before a payment, procurement, SaaS subscription, invoice, refund, or other sensitive financial action.
- `permit_execute_approved_action` executes only after Permit returns a valid one-time approval token.

Install on the server where Hermes runs:

```bash
npm install -g hermes-premit
permit init
permit install hermes
HOST=127.0.0.1 PORT=4733 permit start
```

Enable the plugin in Hermes:

```bash
hermes plugins enable permit
hermes gateway restart
```

Open the local Permit app:

```text
http://localhost:4733
```

If Hermes is running on a remote server, tunnel the local web app:

```bash
ssh -L 4733:127.0.0.1:4733 user@your-server
```

See [docs/HERMES_INTEGRATION.md](docs/HERMES_INTEGRATION.md) for the detailed plugin flow.

## Demo Scenario

Ask Hermes in Telegram:

```text
Use Permit before doing this: buy 5 Figma seats for the design team for 75 USD/month.
```

Expected flow:

1. Hermes detects a procurement/payment action and calls Permit.
2. Permit creates an action draft and runs the active finance policy.
3. Permit blocks execution and sends an approval request to the configured CFO/admin.
4. The CFO/admin approves or rejects from Telegram or the Permit web app.
5. If approved, Permit sends Hermes a one-time approval token through the integration path.
6. Execution runs through the Stripe test connector when configured, or the mock connector otherwise.
7. Permit stores an append-only receipt visible in the audit ledger.

Rejected or unauthorized approval attempts are logged. Sensitive execution without a valid Permit token is denied.

## What The Web App Shows

The local web app is intentionally small:

- setup for company, CFO/admin Telegram ID, Hermes webhook, connector, and policy defaults;
- pending approval inbox;
- policy view;
- audit ledger;
- receipt detail with requester, approver, policy decision, execution result, external ID, previous hash, and receipt hash.

This is not a broad enterprise dashboard. It is the minimum control surface needed to demo the Hermes approval loop.

## Local Development

Requires Node 20 or newer.

```bash
npm install
npm run permit -- init
npm run permit -- install hermes
npm run permit -- seed
npm run permit -- start
```

Useful commands:

```bash
npm run permit -- status
npm run permit -- doctor
npm run check
npm run test
npm run build
```

## Implementation

This repository contains a minimal TypeScript/Node MVP:

- CLI command: `permit`
- database: SQLite via `better-sqlite3`
- local web/API server
- Hermes hook/plugin installer
- Telegram approval interface with explicit sender-id checks
- Stripe test-mode connector with mock fallback
- append-only audit receipts with policy version, `previous_hash`, and `receipt_hash`

Key docs:

- [PRD.md](PRD.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/DEMO.md](docs/DEMO.md)
- [docs/HERMES_INTEGRATION.md](docs/HERMES_INTEGRATION.md)

## MVP Scope

The hackathon MVP proves one thing:

> An enterprise agent can request a real business action, but it cannot execute or bypass finance policy without approval and audit.

Included:

- CLI initialization and startup;
- local setup, approvals, policy, audit, and receipt pages;
- SQLite storage for config, policies, action drafts, approvals, approval tokens, executions, receipts, and audit events;
- Hermes plugin/hook simulation;
- Telegram-style CFO/admin approval path;
- Stripe test or mock execution;
- token-gated execution and tamper-evident receipts.

Not included:

- production payment processing by default;
- large enterprise RBAC;
- a full SaaS dashboard;
- generic agent-platform support;
- automatic wrapping of every possible Hermes financial tool.

For strict production enforcement, every sensitive execution tool must be wrapped so it refuses to run without a valid Permit token.

## API Smoke Test

The API is mainly here to support the Hermes integration and local verification.

```bash
curl -s http://127.0.0.1:4733/api/actions/draft \
  -H 'content-type: application/json' \
  -d '{"source_agent":"hermes","requester":"Bruce","action_type":"saas_purchase","vendor":"Figma","amount":75,"currency":"USD","recurring":true,"reason":"Buy 5 Figma seats"}'
```

Approve with the configured CFO/admin Telegram ID:

```bash
curl -s http://127.0.0.1:4733/api/approvals/<approval_id>/approve \
  -H 'content-type: application/json' \
  -d '{"telegram_user_id":"<configured CFO Telegram ID>","note":"approved"}'
```

Execute only with the returned Permit token:

```bash
curl -s http://127.0.0.1:4733/api/actions/<action_id>/execute \
  -H 'content-type: application/json' \
  -d '{"approval_token":"permit_..."}'
```

In the Hermes demo, users should not call this flow manually. Hermes and Permit exchange the token internally after approval.
