Mr.Ryan 已修复 `src/cart.js`：

- 平铺折扣改为先扣减、后计税。
- 新增 `applyCoupon`，支持按顺序叠加 `percentage` 和 `flat` 优惠券。

已执行 `npm test`，全部通过。