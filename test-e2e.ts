/**
 * test-e2e.ts
 *
 * Prueba completa: foto -> parseReceipt -> saveReceipt -> consulta la
 * alacena resultante en la base para confirmar que quedó bien guardada.
 *
 * Uso:
 *   npx tsx test-e2e.ts ./tickettest2.jpg es
 *
 * Usa un userId fijo de prueba (UUID inventado) ya que todavía no hay
 * tabla de usuarios — reemplazar más adelante por el user real logueado.
 */

import { readFileSync } from "fs";
import { eq } from "drizzle-orm";
import { parseReceipt } from "./receiptParser";
import { saveReceipt } from "./receiptService";
import { db } from "./db";
import { pantryItems } from "./schema";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

// Postgres devuelve las columnas numeric con todos los decimales de precisión
// definidos en el schema (ej "1.000"), aunque el valor sea entero. Esto es
// solo para mostrarlo más limpio en consola — el dato guardado no cambia.
function formatQuantity(value: string): string {
  const num = Number(value);
  return Number.isInteger(num) ? num.toString() : num.toString();
}

async function main() {
  const [, , imagePath, targetLanguage] = process.argv;

  if (!imagePath) {
    console.error("Uso: npx tsx test-e2e.ts <ruta-imagen> [idioma]");
    process.exit(1);
  }

  const imageBuffer = readFileSync(imagePath);
  const imageBase64 = imageBuffer.toString("base64");
  const ext = imagePath.split(".").pop()?.toLowerCase();
  const mediaType =
    ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";

  console.log(`1. Parseando ${imagePath}...`);
  const parsed = await parseReceipt(imageBase64, mediaType, targetLanguage ?? "es");
  console.log(
    `   -> ${parsed.items.length} items detectados, checksum_ok: ${parsed.checksum_ok}`
  );

  console.log("2. Guardando en la base...");
  const { receipt, pantryItemsCreated } = await saveReceipt(TEST_USER_ID, parsed);
  console.log(
    `   -> receipt ${receipt.id} guardado, ${pantryItemsCreated} productos agregados a la alacena`
  );

  console.log("3. Consultando la alacena para confirmar...");
  const currentPantry = await db
    .select()
    .from(pantryItems)
    .where(eq(pantryItems.userId, TEST_USER_ID));

  console.log(`   -> ${currentPantry.length} productos totales en la alacena de prueba:`);
  for (const item of currentPantry) {
    console.log(
      `      - ${item.displayName}: ${formatQuantity(item.quantity)} ${item.unit} (vence: ${
        item.estimatedExpirationDate?.toISOString().split("T")[0] ?? "sin estimar"
      })`
    );
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
