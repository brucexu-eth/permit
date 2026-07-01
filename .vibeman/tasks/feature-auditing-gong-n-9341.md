---
id: feature-auditing-gong-n-9341
title: Auditing 功能完善和测试
type: feature
status: done
tags: 'audit, stripe, web'
priority: medium
created_at: '2026-06-29T13:52:51.301Z'
updated_at: '2026-06-29T15:20:55Z'
---

## Goal

补齐 Permit 的审计视图，使后台能够查看 Stripe 相关执行记录，并按收入/支出方向查看更完整的审计明细。完成后，演示环境中的管理员可以更直接地核对资金流向和对应 receipt。

## Context

当前仓库已提供审计台账和回执详情页，`/audit` 与 `/receipts/:id` 由 `src/server.ts` 提供，回执数据由 `src/db.ts` 写入 `audit_receipts` 表。

执行连接器位于 `src/stripe.ts`，当前支持 `stripe_test` 与 `mock` 两种 connector；README、PRD、`docs/ARCHITECTURE.md`、`docs/DEMO.md` 均将 audit ledger 和 receipt detail 定义为 MVP 范围，但未定义收入/支出的展示口径。

## Requirements

- [x] 审计列表或详情页能区分并展示 Stripe 相关执行记录的资金方向，至少能让管理员判断该记录属于收入或支出。
- [x] 审计明细中能看到与 Stripe 执行结果相关的关键字段，至少包含 connector、external id 或等价标识，以及与该记录关联的 action/receipt 信息。
- [x] 现有 `/audit` 与 `/receipts/:id` 页面在无 Stripe key 或 mock 执行场景下仍可正常显示，不因新增字段缺失而报错。
- [x] 至少有一项验证覆盖审计页或回执数据的新增展示，证明收入/支出与 Stripe 审计信息可被读取。

## Implementation Notes

- 相关代码主要在 `src/server.ts`、`src/db.ts`、`src/stripe.ts`，测试目录在 `test/`。
- 现有审计数据源为 `audit_receipts`、`executions`、`action_drafts` 等 SQLite 表；receipt 已包含 `policy_version`、`previous_hash`、`receipt_hash`。
- 验证命令优先参考 `npm run check`，必要时补充最小范围的测试命令。
- 保持 MVP 范围，不扩展为完整财务报表，不引入真实生产支付能力。

## Recommended Steps

- Step 1: 审计数据口径梳理
  - [x] 明确现有 receipt、execution、action draft 中哪些字段可用于标记收入/支出与 Stripe 执行结果。
  - [x] 确认审计页面缺失的最小展示字段，并定义无数据时的回退展示。
- Step 2: 页面与数据补齐
  - [x] 在审计列表或详情页补充资金方向与 Stripe 关键字段展示。
  - [x] 保持 mock 与 `stripe_test` 两条路径的兼容，不要求重做现有审计结构。
- Step 3: 验证
  - [x] 增加或更新一项最小测试/校验，覆盖新增审计展示。
  - [x] 运行相关检查并记录结果，确认 `/audit` 与 `/receipts/:id` 行为未回退。

## Open Questions

- Question: “收入”在本任务中是否指 Stripe 收款类记录，而不仅是当前采购/付款场景的支出记录？
  - Answer: 是的，收款类记录。但是应该是模拟的。
- Question: 资金方向应基于 `action_type`、执行 connector 返回值，还是新增独立字段来定义？
  - Answer: 你看看怎么能拿到就可以。反正是黑客松 MVP。
- Question: 审计信息只需体现在 Web 页面，还是还需要扩展 `/api/audit` 与 `/api/audit/:id` 的返回结构？
  - Answer: 简单展示，用于演示。

## Implementation Summary

- 在 `src/db.ts` 的 receipt 写入逻辑中补充 `audit_summary`，把资金方向、connector、external id 和 action id 一并写入 receipt；资金方向通过 `deriveFundsDirection` 基于 action type/reason/vendor 做 MVP 级别推断，缺失字段时保留回退。
- 在 `src/server.ts` 的 `/audit` 和 `/receipts/:id` 页面中展示 `Funds in/Funds out`、connector、external id、action id、receipt id，并在解析 receipt 时对 mock 和无 Stripe key 场景做兼容回退，避免新增字段缺失时报错。
- 在 `test/e2e.ts` 增加/保留针对审计页和 receipt 页的断言，覆盖 inflow/outflow、mock external id、connector 和详情字段展示。
- 验证命令：
  - `npm run check`
  - `npm test`
