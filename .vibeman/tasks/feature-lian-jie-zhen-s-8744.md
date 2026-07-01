---
id: feature-lian-jie-zhen-s-8744
title: 链接真实的 Stripe 测试环境
type: feature
status: done
priority: medium
created_at: '2026-06-29T13:19:45.962Z'
updated_at: '2026-06-29T13:29:52Z'
---

目前似乎是在本地模拟环境，切换到真实的 stripe 的测试环境和 API 调用，能够在 stripe 上面看到具体的请求和内容。

## Implementation Summary

- 将 `src/stripe.ts` 从本地伪造 `pi_test_permit_*` 改为真实调用 Stripe test-mode `POST /v1/payment_intents`，把 Permit action 信息写入 description 和 metadata，这样可以在 Stripe 控制台看到实际请求与内容。
- 保留现有安全边界：只有 `sk_test_` key 才走真实 Stripe；未配置 test key 时继续走 mock；Stripe 临时不可用时自动回退 mock 并记录 fallback 原因，避免中断演示流程。
- 扩展 `test/e2e.ts`，覆盖真实 Stripe 请求分支，校验请求地址、Bearer key、金额换算和 metadata 是否正确。
- 运行命令：`npm install`、`npm run check`、`npm test`。
