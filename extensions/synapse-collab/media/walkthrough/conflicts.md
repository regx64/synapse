# Watch for conflicts

Synapse tracks which functions, methods and classes each agent changes, and warns before you merge when:

- two agents change the **same symbol**;
- one agent changes a function's **signature** while another agent's new code calls it the old way: git merges this cleanly, and the build breaks;
- the agents' changes would **not merge as text**.

Markers in the editor show whose code you are looking at. Conflicts appear on the board and in the Problems panel.
