# Demo Script

## Demo title

Permit: approval and audit for enterprise AI agent payments.

## Setup

```bash
permit init
permit start
permit install hermes
```

Open the local web app and configure:

- company name: Acme AI Ops
- admin: Bruce
- CFO Telegram ID: configured private Telegram user
- connector: Stripe test mode or mock payment
- policy: recurring SaaS purchases require CFO approval

## Scenario

In Telegram, ask Hermes:

```text
Buy 5 Figma seats for the design team using the company payment method.
```

Expected Hermes response:

```text
Permit intercepted a financial action.

Action: purchase SaaS subscription
Vendor: Figma
Amount: estimated recurring monthly spend
Policy: CFO approval required
Status: waiting for approval
```

CFO receives Telegram DM:

```text
Permit approval required

Requester: Bruce
Agent: Hermes
Vendor: Figma
Action: SaaS purchase
Reason: design team seats
Policy triggered: recurring SaaS purchase

Reply:
/approve <id>
/reject <id> <reason>
/simulate <id>
```

After approval:

```text
Approved by CFO.
Execution: Stripe test payment or mock payment succeeded.
Audit receipt created.
```

Web app should show:

- pending approval before approval;
- approved/executed action after approval;
- receipt detail with requester, approver, policy version, execution result, and receipt hash.

## Key narrative

Do not pitch this as only an agent payment demo.

Pitch:

> Agent payments are the visible demo. Auditability is the enterprise adoption blocker. Permit gives Hermes and other agents the permission, approval, execution, and audit layer required before agents can safely touch money.
