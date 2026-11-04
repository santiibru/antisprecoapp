/**
 * test.ts
 *
 * Script de prueba manual: lee una foto de ticket desde disco y llama a
 * parseReceipt para ver la respuesta real de la API.
 *
 * Uso:
 *   npx tsx test.ts ./ticket1.jpg es
 *   npx tsx test.ts ./ticket1.jpg it
 */

import { readFileSync } from "fs";
import { parseReceipt } from "./receiptParser";

async function main() {
  const [, , imagePath, targetLanguage] = process.argv;

  if (!imagePath) {
    console.error("Uso: npx tsx test.ts <ruta-imagen> [idioma]");
    process.exit(1);
  }

  const imageBuffer = readFileSync(imagePath);
  const imageBase64 = imageBuffer.toString("base64");

  const ext = imagePath.split(".").pop()?.toLowerCase();
  const mediaType =
    ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";

  console.log(`Parseando ${imagePath} (idioma destino: ${targetLanguage ?? "es"})...`);

  const result = await parseReceipt(imageBase64, mediaType, targetLanguage ?? "es");

  console.log(JSON.stringify(result, null, 2));
  console.log(`\nTotal items detectados: ${result.items.length}`);
  console.log(
    `Confianza baja: ${result.items.filter((i) => i.confidence === "low").length}`
  );
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
