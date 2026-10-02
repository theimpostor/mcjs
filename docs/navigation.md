# Navigation and gathering

The default pathfinder plugin exposes bot.pathfinder, goals and Movements.
Use `await helpers.goto(new goals.GoalNear(x, y, z, radius))` to navigate.
The direct API is `await bot.pathfinder.goto(goal)`. `GoalBlock` targets an exact
block position; `GoalNear` accepts a distance tolerance; `GoalFollow(entity, range)`
is useful for following a loaded entity. Stop with bot.pathfinder.setGoal(null).

Default Movements disables incidental digging and block towers. Explicitly
configure a new Movements(bot) and bot.pathfinder.setMovements(movements) if your
task requires modifying terrain during navigation. No path is guaranteed.

Find nearby blocks with bot.findBlock({matching: b => b.name === 'oak_log',
maxDistance: 32}). Check null. Search only covers loaded chunks. For gathering,
`await helpers.collect(block)` uses the collection plugin's navigation, tool
selection, digging and drop collection. Inspect inventory after completion.
`await bot.tool.equipForBlock(block)` selects a suitable available tool.

PVP is opt-in at bot creation with --plugins pathfinder,tool,collectblock,pvp.
Use bot.pvp.attack(entity) to begin and await bot.pvp.stop() in finally. Keep
combat inside a background job, observing health and cancellation. Never classify
all entities whose type is mob as hostile; use explicit version-aware names.

Upstream: https://github.com/PrismarineJS/mineflayer-pathfinder
https://github.com/PrismarineJS/mineflayer-collectblock
https://github.com/PrismarineJS/mineflayer-pvp
