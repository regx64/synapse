/** Amounts are integer cents. */
export function applyDiscount(totalCents, percent) {
  return totalCents - Math.round((totalCents * percent) / 100);
}

export function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
