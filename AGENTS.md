# AGENTS.md

## Project

Permit is a minimal hackathon MVP for an installable approval and audit layer for enterprise AI agent financial actions.

## Constraints

- Keep the implementation simple and demo-oriented.
- Use SQLite as the default database.
- Prefer TypeScript/Node if choosing a stack.
- Do not build a large enterprise dashboard.
- Do not require real production payments.
- Stripe must be test mode only by default.
- Hermes must not hold Stripe secret keys.
- Sensitive execution must require a Permit approval token; prompt instructions alone are not enough.

## MVP acceptance criteria

- CLI can initialize and start the app.
- Local web app supports setup, pending approvals, audit ledger, and receipt detail.
- SQLite stores config, policies, action drafts, approvals, executions, and receipts.
- There is a minimal Hermes integration/hook or clear local simulation for it.
- Telegram CFO approval can be mocked or implemented with environment-based bot config, but the interface and sender-id check must be explicit.
- Stripe connector uses test mode or falls back to mock execution.
- Audit receipts include policy version and hash-chain fields.

## Documentation source of truth

Read `README.md`, `PRD.md`, `docs/ARCHITECTURE.md`, and `docs/DEMO.md` before implementing.
