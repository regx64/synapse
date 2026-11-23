# Split the work into tasks

On the board's **Tasks** tab:

1. Create a task per piece of work and assign it to an agent.
2. Say which tasks depend on which. A task stays blocked until its dependencies are done.
3. Tick **start automatically** to have it start as soon as it is unblocked.

When an agent finishes, the task waits for your review. Marking it done hands off to the next agent: a structured message with the files and symbols the first agent changed (taken from git, not from the agent's own words) and its summary.

Accepted **decisions** are included in every task prompt. Agents can propose decisions; you accept or reject them.
