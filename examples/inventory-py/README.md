# Example: inventory (Python)

A small inventory with reservations and standard-library tests
(`python3 -m unittest`). Synapse's ownership tracking parses Python, so
conflicts are reported per class and method.

## Scenario

```bash
cp -r examples/inventory-py /tmp/inventory
```

```bash
cd /tmp/inventory && git init -q -b main && git add -A && git commit -qm init
```

```bash
synapse agent add claude --start
```

```bash
synapse agent add codex --start
```

```bash
synapse task add Reservations expire --agent claude --description "Give Inventory.reserve a ttl_seconds parameter and track expiry. Update tests."
```

```bash
synapse task add Restock alerts --agent codex --description "Add alerts.py with low_stock(inventory, threshold) that reserves a safety buffer with Inventory.reserve. Add tests."
```

```bash
synapse task start t-1
```

```bash
synapse task start t-2
```

Then run `synapse status`. If Claude makes `ttl_seconds` required while
Codex calls `reserve(sku, quantity)`, Synapse flags a signature-change
conflict before anything is merged. If Claude gives it a default, the call
still fits and no conflict is raised. Finish with `synapse review`.
