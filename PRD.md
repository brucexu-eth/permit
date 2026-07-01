# Permit PRD

## 1. Overview

Permit is an approval and audit layer for AI agents that perform financial or high-risk business actions. The initial product integrates with Hermes Agent, Telegram, a local web app, SQLite, and Stripe test mode.

The hackathon version should prove one thing clearly:

> An enterprise agent can request a real business action, but it cannot execute or bypass finance policy without approval and audit.

## 2. Target users

### Primary user: founder / operator / CFO

Needs to let agents help with procurement, payments, subscriptions, and admin work, but wants control over money and audit trails.

### Secondary user: agent developer

Needs a simple way to add policy checks and approvals before calling sensitive tools.

## 3. Jobs to be done

1. When an agent wants to spend money, I want it to request approval before execution so I can prevent unauthorized spend.
2. When an agent executes a payment or purchase, I want a durable receipt so I can later answer who approved what and why.
3. When I install an agent tool, I want financial credentials isolated from the agent so the agent cannot bypass policy.
4. When an approval is needed, I want it delivered in the channel I already use, starting with Telegram DM.
5. When I review finance activity, I want a web ledger of pending and completed actions.

## 4. Product principles

- **Tool-level enforcement, not prompt trust.** Hermes instructions are not security. Sensitive tools must refuse execution without a Permit approval token.
- **Credential separation.** Hermes should not hold the Stripe secret key. Permit owns the payment credential and execution connector.
- **Human authority remains explicit.** Only the configured CFO/admin Telegram ID can approve high-risk financial actions.
- **Audit by default.** Every draft, policy result, approval decision, execution result, and failure creates an audit event.
- **Local-first MVP.** SQLite is enough. The demo should run locally with simple setup.

## 5. MVP user flows

### Flow A: First-run setup

1. User runs `permit init`.
2. User runs `permit start`.
3. Browser opens the local Permit web app.
4. Setup wizard asks for:
   - company name;
   - admin name;
   - CFO Telegram ID;
   - Telegram bot or Hermes delivery config;
   - Stripe test secret key;
   - default currency;
   - basic policy thresholds.
5. Setup creates the local SQLite database.
6. User runs `permit install hermes` to install Hermes hooks.

### Flow B: Procurement/payment approval

1. User asks Hermes in Telegram to buy a SaaS subscription or pay a vendor.
2. Hermes hook converts the request into an action draft.
3. Permit checks finance policy.
4. If approval is required, Permit creates an approval request.
5. CFO receives a Telegram DM with action details and buttons or command options.
6. CFO approves, rejects, or marks simulate-only.
7. Permit issues a one-time approval token.
8. The execution connector uses Stripe test mode or mock execution.
9. Permit writes an audit receipt.
10. Hermes reports the result back to the user.

### Flow C: Web audit review

1. Admin opens the Permit web app.
2. Admin sees pending approvals and historical receipts.
3. Admin can filter by status, requester, vendor, amount, and date.
4. Admin can open a receipt and view policy result, approver, execution result, Stripe object ID, and receipt hash.

## 6. Core entities

### User

- id
- name
- role: admin, cfo, requester
- telegram_user_id
- created_at

### Policy

- id
- version
- name
- status
- rules_json
- created_at

### ActionDraft

- id
- source_agent
- requester
- action_type
- vendor
- amount
- currency
- recurring
- reason
- risk_level
- raw_request
- status
- created_at

### PolicyDecision

- id
- action_id
- policy_id
- policy_version
- result: allow, require_approval, block
- reasons_json
- created_at

### ApprovalRequest

- id
- action_id
- approver_user_id
- status: pending, approved, rejected, simulate_only, expired
- decision_note
- decided_at
- created_at

### ApprovalToken

- id
- action_id
- token_hash
- expires_at
- used_at
- created_at

### Execution

- id
- action_id
- connector: stripe_test, mock
- status: not_started, started, succeeded, failed
- external_id
- error
- created_at
- updated_at

### AuditReceipt

- id
- action_id
- receipt_json
- previous_hash
- receipt_hash
- created_at

## 7. Policy examples

Default MVP policies:

1. Auto-allow mock actions under 10 USD.
2. Require CFO approval for any real Stripe execution.
3. Require CFO approval for recurring subscriptions.
4. Block unknown vendor payments above 500 USD.
5. Block execution when no CFO Telegram ID is configured.

## 8. CLI requirements

The CLI should support:

```bash
permit init
permit start
permit install hermes
permit status
permit doctor
```

Nice-to-have:

```bash
permit demo
permit receipt <id>
```

## 9. Web app requirements

Minimum pages:

1. Setup wizard.
2. Approval inbox.
3. Audit ledger.
4. Policy settings.
5. Action detail / receipt detail.

## 10. Hermes integration requirements

The Hermes integration should be minimal:

1. A hook/tool wrapper that detects financial/procurement actions.
2. A local API call to Permit to create/check action drafts.
3. A hard execution guard: no approval token, no sensitive execution.
4. A result callback so Hermes can report approved/rejected/executed states.

## 11. Telegram approval requirements

MVP can use simple text commands if buttons are too slow:

```text
/approve <approval_id>
/reject <approval_id> <reason>
/simulate <approval_id>
```

Security requirements:

- Only the configured CFO Telegram ID can approve.
- Every rejected unauthorized approval attempt must be logged.
- Approval status must be rechecked before execution.

## 12. Stripe requirements

- Use Stripe test mode only for MVP.
- Store the Stripe secret key in local environment/config, not inside Hermes.
- If Stripe is unavailable, fall back to mock execution while preserving the same audit flow.

## 13. Success criteria

The demo is successful if a reviewer can see:

1. Permit installed from a repo with a CLI.
2. First-run setup using SQLite.
3. Hermes/Telegram request for a SaaS purchase or payment.
4. Permit blocks execution and notifies the CFO.
5. CFO approves via Telegram or web.
6. Stripe test or mock execution runs only after approval.
7. Audit receipt appears in the web app.
8. The receipt proves who requested, who approved, which policy applied, what executed, and whether the ledger is tamper-evident.

## 14. Open questions

- Should the first connector demo be Stripe PaymentIntent, Stripe Checkout, or mock invoice payment?
- Which Hermes hook mechanism is fastest and least invasive for the hackathon?
- Should Telegram approval be implemented through Hermes delivery, a standalone bot, or both?
- How much of the web app should be server-rendered versus API + frontend?
