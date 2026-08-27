Mr.Ryan 已修复税前扣减折扣：`src/cart.js:10`。

验证：
```text
✔ tests 2
✔ pass 2
✔ fail 0
```

优惠券叠加的接口与规则未定义。请明确 `applyCoupon` 的参数格式、优惠券类型（金额/百分比）及叠加顺序，才能实现。