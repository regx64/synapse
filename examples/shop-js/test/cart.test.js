import { test } from "node:test";
import assert from "node:assert/strict";
import { Cart } from "../src/cart.js";
import { applyDiscount, formatPrice } from "../src/pricing.js";

test("discounts round to whole cents", () => {
  assert.equal(applyDiscount(999, 10), 899);
});

test("cart totals and receipt", () => {
  const cart = new Cart();
  cart.add("Tea", 450, 2);
  cart.add("Mug", 1200);
  assert.equal(cart.subtotal(), 2100);
  assert.equal(cart.total(10), 1890);
  assert.match(cart.receipt(10), /Total {2}\$18\.90$/);
  assert.equal(formatPrice(5), "$0.05");
});
