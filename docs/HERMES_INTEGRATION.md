# Hermes Agent Integration

Permit integrates with Hermes as a user plugin. The plugin gives Hermes two tools:

- `permit_request_financial_action` — create an approval request before a payment/procurement action.
- `permit_execute_approved_action` — execute only after Permit returns a one-time approval token.

This is intentionally tool-level enforcement. Hermes should not hold Stripe credentials; Permit owns the Stripe/mock connector and the audit ledger.

## Server setup

Install Permit on the server where Hermes runs:

```bash
npm install -g hermes-premit
permit init
permit seed
permit install hermes
HOST=127.0.0.1 PORT=4733 permit start
```

The installed command is still `permit`.

## Local development setup

```bash
npm install
npm run permit -- init
npm run permit -- seed
npm run permit -- install hermes
npm run permit -- start
```

Then enable the plugin in Hermes:

```bash
hermes plugins enable permit
```

Restart the Hermes CLI or gateway after enabling the plugin.

For Telegram gateway use:

```bash
hermes gateway restart
```

## Manual test prompt in Hermes

Ask Hermes:

```text
Use Permit before doing this: buy 5 Figma seats for the design team for 75 USD/month.
```

Expected behavior:

1. Hermes calls `permit_request_financial_action`.
2. Permit creates an action draft and approval request.
3. The approval appears in the Permit web app `/approvals`.
4. CFO approves with Telegram ID `12345` in the demo UI or API.
5. Hermes can only execute with the returned one-time Permit token.
6. Permit creates a receipt under `/audit`.

## API smoke test

With the server running:

```bash
curl -s http://127.0.0.1:4733/api/actions/draft \
  -H 'content-type: application/json' \
  -d '{"source_agent":"hermes","requester":"Bruce","action_type":"saas_purchase","vendor":"Figma","amount":75,"currency":"USD","recurring":true,"reason":"Buy 5 Figma seats"}'
```

Approve with the demo CFO ID:

```bash
curl -s http://127.0.0.1:4733/api/approvals/<approval_id>/approve \
  -H 'content-type: application/json' \
  -d '{"telegram_user_id":"12345","note":"approved"}'
```

Execute with the returned token:

```bash
curl -s http://127.0.0.1:4733/api/actions/<action_id>/execute \
  -H 'content-type: application/json' \
  -d '{"approval_token":"permit_..."}'
```

## Current MVP limitation

The plugin exposes explicit Permit tools. It does not yet automatically rewrite every existing Hermes payment/procurement tool. For strict production enforcement, sensitive tools must be wrapped so they refuse execution unless a valid Permit token is present.
