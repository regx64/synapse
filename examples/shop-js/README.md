# Example: a small shop (JavaScript)

A tiny cart and pricing module with tests (`npm test`, no dependencies). Use
it to try Synapse with two real agents.

## Set up

Copy this folder somewhere outside the Synapse repository and make it a git
repository of its own:

```bash
cp -r examples/shop-js /tmp/shop
```

```bash
cd /tmp/shop && git init -q -b main && git add -A && git commit -qm init
```

```bash
synapse agent add claude --start
```

```bash
synapse agent add codex --start
```

(Or open the folder in the Synapse IDE and use the board.)

## A scenario that breaks without coordination

Two tasks that are fine alone and break together:

```bash
synapse task add Cap discounts --agent claude --scope "src/pricing.js,src/cart.js,test/**" --description "Give applyDiscount a third parameter maxDiscountCents and update its callers and tests."
```

```bash
synapse task add Gift cards --agent codex --description "Add src/giftcard.js with redeem(cart, code) that applies a 15% discount using applyDiscount, with tests."
```

```bash
synapse task start t-1
```

```bash
synapse task start t-2
```

While they work:

```bash
synapse status
```

Expect a **signature-change** conflict: Claude changes `applyDiscount`'s
parameters while Codex's new `redeem` calls it the old way. Git would merge
both branches cleanly; the code would break. Tell Codex, then:

```bash
synapse review
```

The combined review merges both agents' work in a scratch worktree, runs
`npm test` there, and only then lets you merge.

## Try the shared decision log

```bash
synapse decision add Money --decision "All amounts are integer cents" --rationale "No float rounding"
```

Accepted decisions are included in every task prompt and written to
`docs/decisions.md`.
