# Operating loop

1. Run doctor and bot list. Confirm the requested server and identities.
2. Observe with bot snapshot, inventory, and relevant events.
3. Discover unfamiliar APIs with docs and namespace inspection.
4. Execute a bounded program with explicit success/failure output.
5. Inspect the job state and resulting world/inventory state.
6. Update JSON memory and shared coordination, then choose the next action.

For long tasks, submit a background job and keep its ID. Poll the job and read
cursor-based events; do not submit another movement program to the same busy bot.
Use separate bots for concurrent work, with shared resource claims for common
chests or build regions. Stop controllers in finally if you invoke raw APIs.

After transport failure, query jobs before resubmitting. After timeout/cancellation,
verify whether actions already happened. A quarantined bot requires a deliberate
reconnect; do not assume a timed-out Promise terminated its underlying code.
Do not report a successful build, delivery or craft without checking the result.
