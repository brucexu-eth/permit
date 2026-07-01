---
id: feature-stripe-test-sec-2935
title: Stripe test secret key 做一个隐藏
type: feature
status: done
priority: medium
created_at: '2026-06-29T06:20:13.838Z'
updated_at: '2026-06-29T07:39:40Z'
---

目前这个字段保存完之后，它还是以铭文方式显示，可能会泄露我的 Secret Key。不用很复杂的算法，就在前端隐藏就可以了。

## Implementation Summary

- Updated the setup page so the saved Stripe test secret key is no longer rendered back into the form as plain text. The field now uses a password input with an empty value plus a hidden-state hint, while still allowing entry of a replacement key.
- Preserved the existing save behavior so leaving the field blank does not overwrite the stored key and the app can continue using the saved Stripe test configuration.
- Added an end-to-end UI assertion that requests the setup page HTML and verifies the saved `sk_test_...` value is not present in the rendered response.

Commands run:
- `npm install`
- `npm test`
- `npm run check`
