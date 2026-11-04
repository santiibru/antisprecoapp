/**
 * reset-test-data.ts
 *
 * Borra todos los receipts y pantry_items del usuario de prueba, para
 * poder correr test-e2e.ts las veces que haga falta sin acumular duplicados.
 *
 * Uso: npx tsx reset-test-data.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./db";
import { receipts, pantryItems } from "./schema";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

async function main() {
  // receipt_items se borra solo por el ON DELETE CASCADE del schema
  const deletedReceipts = await db
    .delete(receipts)
    .where(eq(receipts.userId, TEST_USER_ID))
    .returning();

  const deletedPantry = await db
    .delete(pantryItems)
    .where(eq(pantryItems.userId, TEST_USER_ID))
    .returning();

  console.log(
    `Borrados: ${deletedReceipts.length} receipts, ${deletedPantry.length} pantry items`
  );
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
