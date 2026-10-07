# mcjs API guide

Use `mcjs docs <topic>` for execution, navigation, inventory, coordination,
connection, viewer, or troubleshooting. Documentation works with the daemon stopped.
Use `mcjs bot info <id>` to check loaded plugins; package installation alone does
not mean a plugin is active. `mcjs inspect <id> bot.pathfinder` lists live method
names without invoking getters.

The CLI submits JS/TS async function bodies, supports await, and returns the
explicit return value as JSON in a job record. Ordinary variables are local to
one call. Persist JSON values in botState or shared, never entity objects.

Globals: bot (Mineflayer Bot), mcData (negotiated-version minecraft-data), Vec3,
goals, Movements, botState, shared, signal, helpers, log and captured console.

Core observations: bot.entity.position, bot.health, bot.food,
bot.inventory.items(), bot.entities, bot.players, bot.findBlock(options),
bot.findBlocks(options), bot.blockAt(position), helpers.snapshot().

Common actions: bot.chat(text), bot.equip(item, destination), bot.dig(block),
bot.placeBlock(referenceBlock, faceVector), bot.craft(recipe, count, table),
bot.openContainer(block), bot.openFurnace(block), helpers.goto(goal), and
helpers.collect(blockOrBlocks). Confirm specialized signatures against installed
Mineflayer types in node_modules/mineflayer/index.d.ts and plugin declarations.

Documentation: https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md
