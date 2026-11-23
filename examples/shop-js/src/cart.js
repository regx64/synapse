import { applyDiscount, formatPrice } from "./pricing.js";

export class Cart {
  constructor() {
    this.items = [];
  }

  add(name, priceCents, quantity = 1) {
    this.items.push({ name, priceCents, quantity });
  }

  subtotal() {
    return this.items.reduce((sum, i) => sum + i.priceCents * i.quantity, 0);
  }

  total(discountPercent = 0) {
    return applyDiscount(this.subtotal(), discountPercent);
  }

  receipt(discountPercent = 0) {
    const lines = this.items.map((i) => `${i.quantity} x ${i.name}  ${formatPrice(i.priceCents * i.quantity)}`);
    return [...lines, `Total  ${formatPrice(this.total(discountPercent))}`].join("\n");
  }
}
