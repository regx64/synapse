# Review and merge in one pass

**Combined review** merges every agent's work into a scratch worktree, runs your `testCommand` there, and shows:

- every changed file, which agents changed it, and a diff against your branch;
- the test result on the combined code;
- any conflicts still open.

**Merge** fast-forwards your branch to the combined result. It is refused while tests fail or conflicts remain, unless you choose to merge anyway. Agents whose work was merged start fresh from the new base.
