# Inventory and containers

Return bot.inventory.items().map(i => ({name:i.name,count:i.count,slot:i.slot})).
Find items by registry name, check existence, then await bot.equip(item, 'hand').
Other equip destinations include head, torso, legs, feet and off-hand.

Use bot.recipesFor(itemId, metadata, minResultCount, craftingTable) to find
available crafting recipes; await bot.craft(recipe, craftCount, craftingTable).
Look up item IDs through mcData.itemsByName. Craft count counts recipe operations;
it does not necessarily equal output item count. Navigate within reach of the
crafting table before requesting table recipes.
Check recipes.length before choosing one. Recipe instances are not supported
return values: report `{available: recipes.length}` or project the fields needed
into plain JSON instead of returning bot.recipesFor(...) directly.

Open containers using await bot.openContainer(block). Await transfers. Close in
finally. Coordinate a shared chest using a resource lease before interacting.
For furnaces use await bot.openFurnace(block); inspect the installed type/API
for fuel, input and output transfer methods. Wait with helpers.sleep and check
completion rather than assuming a fixed smelting duration.

Place blocks by equipping the intended item, finding an adjacent reference block,
then await bot.placeBlock(referenceBlock, new Vec3(faceX, faceY, faceZ)). The face
vector is one of the six unit axis vectors. Verify the resulting block with
bot.blockAt; protect against stale references when the world changes.
