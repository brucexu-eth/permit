---
id: feature-you-hua-jie-mia-0837
title: 优化界面
type: feature
priority: medium
created_at: '2026-06-29T06:16:08.411Z'
updated_at: '2026-06-29T12:59:44Z'
status: done
---

去掉这种紫色渐变风格，就是平铺就可以。

说明文案加上 Stripe Skills for Hermes 和 NemoClaw Nemotron 3 Ultra 相关的介绍，因为它们是黑客松的重要组成部分。简单介绍一下他们带来了什么，有什么帮助等等。

默认不应该首页展示这个 setup，应该在 setup 页面展示。首页就展示有多少等待审批的订单什么的就可以了，然后显示这个列表，以及显示 auditing，就是有多少进出的资金统计。这个 auditing 部分先用 mock data，我在其他 ticket 上再开发。

## Implementation Summary

- Reworked the server-rendered UI from the purple gradient style to a flatter editorial dashboard look with neutral surfaces, updated typography, and simpler table/panel styling.
- Moved setup off the homepage: `/` is now an operations dashboard with pending approval counts, recent order list, and a mock auditing snapshot; `/setup` now owns configuration and demo draft creation.
- Added hackathon-context copy for `Stripe Skills for Hermes` and `NemoClaw Nemotron 3 Ultra` on both the dashboard and setup page, and deduplicated setup user creation by switching to `ensureUser`.
- Validation commands run: `npm ci`, `npm run check`, `npm test`.
