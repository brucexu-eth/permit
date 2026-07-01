# Architecture

## System shape

```text
Hermes / Telegram user request
        |
        v
Hermes Permit Hook
        |
        v
Permit Local API  <----> SQLite
        |                  |
        |                  v
        |            Audit Ledger
        |
        +----> Telegram CFO Approval
        |
        +----> Web App Approval Inbox
        |
        +----> Stripe Test / Mock Connector
```

## Components

### 1. Permit CLI

Responsibilities:

- initialize local config and SQLite database;
- start the web/API server;
- install Hermes hooks or tool wrappers;
- run diagnostics;
- optionally run a demo scenario.

### 2. Permit Web/API server

Responsibilities:

- serve setup wizard and admin UI;
- expose local APIs for Hermes hooks;
- run policy checks;
- manage approvals;
- execute approved connector actions;
- write append-only audit receipts.

Suggested implementation can be simple: one Node/TypeScript app with SQLite.

### 3. SQLite database

SQLite is the default MVP database. It should store users, policies, action drafts, approvals, approval tokens, executions, and audit receipts.

### 4. Hermes hook

Responsibilities:

- detect financial/procurement/payment intent;
- create an action draft through Permit;
- block sensitive tool execution unless Permit returns an approval token;
- report approval or rejection back to the Telegram conversation.

Important: the hook must not rely only on model instructions. The sensitive execution path must check Permit state.

### 5. Telegram approval channel

Responsibilities:

- deliver approval requests to the configured CFO/admin Telegram ID;
- accept approve/reject/simulate decisions;
- verify sender identity;
- notify Hermes when state changes.

### 6. Stripe connector

Responsibilities:

- execute Stripe test-mode payment or create a mock payment record;
- never expose the Stripe secret key to Hermes;
- write the external object ID into the execution and receipt records.

## API sketch

```http
POST /api/actions/draft
POST /api/actions/:id/check
POST /api/approvals/:id/approve
POST /api/approvals/:id/reject
POST /api/approvals/:id/simulate
POST /api/actions/:id/execute
GET  /api/approvals
GET  /api/audit
GET  /api/audit/:id
GET  /health
```

## Enforcement model

The security boundary is credential separation:

- Hermes can request an action.
- Hermes cannot approve the action.
- Hermes cannot access the Stripe secret key.
- Permit owns approval state, execution credentials, and audit receipts.
- The execution connector refuses to run without a valid one-time approval token.

## Audit model

Every important state transition writes an audit event. Final receipts should include:

- action id;
- requester;
- source agent;
- approver;
- policy version;
- decision reasons;
- execution connector;
- external execution id;
- previous receipt hash;
- receipt hash.

A simple hash chain is enough for the MVP.
