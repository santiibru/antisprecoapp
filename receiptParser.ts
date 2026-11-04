/**
 * receiptParser.ts
 *
 * Módulo para parsear tickets de compra (foto) y devolver un inventario
 * estructurado usando la API de Claude (modelo Haiku por costo/tarea simple).
 *
 * Uso esperado en el backend:
 *   const result = await parseReceipt(imageBase64, "image/jpeg", "es");
 *   // result.items -> array listo para insertar en la tabla pantry_items
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";

dotenv.config();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ---- Esquema de salida esperado ----
// Se documenta acá para que el resto del backend (validación con zod, tipos)
// use exactamente esta forma. category siempre en inglés (capa técnica);
// display_name en el idioma que pida el usuario (capa de usuario).

export type ReceiptItem = {
  raw_name: string; // texto tal cual aparece impreso en el ticket, sin tocar
  display_name: string; // nombre traducido/interpretado en target_language
  quantity: number | null; // null si no se pudo inferir con confianza
  unit: "g" | "kg" | "ml" | "l" | "unit" | null;
  line_total: number; // precio de la línea tal como está impreso (siempre presente)
  unit_price: number | null; // solo si quantity es conocido con certeza (ej "2 X 3,99")
  category:
    | "produce"
    | "dairy"
    | "bakery"
    | "meat_fish"
    | "pantry" // enlatados, pastas, harinas, etc.
    | "beverages"
    | "snacks"
    | "cleaning"
    | "personal_care"
    | "other";
  is_food: boolean; // false para limpieza, higiene, bolsas, etc.
  confidence: "high" | "medium" | "low";
};

export type ReceiptParseResult = {
  merchant: string | null;
  purchase_date: string | null; // ISO 8601 si se pudo leer
  currency: string; // ej "EUR", "ARS"
  items: ReceiptItem[];
  discounts_total: number | null;
  total: number | null;
  // Campo agregado por nuestro código, no por el modelo:
  // true si suma(line_total) - discounts_total coincide con total (±1 centavo
  // de tolerancia por redondeo). Detecta errores de lectura que el modelo
  // marcó como confidence "medium"/"high" sin darse cuenta del error.
  checksum_ok: boolean | null; // null si total o algún line_total falta
};

// ---- System prompt ----
// Clave: pedimos SOLO JSON, sin texto adicional, y separamos claramente
// raw_name (nunca traducir) de display_name (siempre traducir a target_language).

function buildSystemPrompt(targetLanguage: string): string {
  return `Sos un asistente que extrae datos estructurados de fotos de tickets de compra de supermercado.

Reglas estrictas:
1. Respondé ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin markdown ni backticks.
2. Por cada línea de producto (ignorá líneas de descuento "Sconto/Descuento", subtotales, medios de pago, y metadata del comercio como CUIT/P.IVA, no son items):
   - raw_name: copiá el texto EXACTO tal como aparece impreso, sin traducir ni corregir.
   - display_name: interpretá qué producto es y devolvé su nombre en el idioma "${targetLanguage}", claro y sin abreviaturas (ej "RUCOLA GR125 CRF" -> "Rúcula").
   - quantity y unit: si el peso o cantidad está en el nombre o en una línea de multiplicador tipo "2 X 3,99" úsalo. Si no podés inferirlo con confianza razonable, poné quantity: null y unit: null (NO inventes un número).
   - line_total: el precio impreso en esa línea (el total que se cobró por esa línea, no un precio unitario inventado).
   - unit_price: SOLO si hay un multiplicador explícito tipo "2 X 3,99" que te permita derivarlo con certeza (line_total / quantity). Si no, poné null — nunca asumas que line_total es el precio por unidad.
   - category: elegí una de: produce, dairy, bakery, meat_fish, pantry, beverages, snacks, cleaning, personal_care, other.
   - is_food: false para productos de limpieza, higiene personal, bolsas, etc.
   - confidence: "low" si el nombre abreviado es ambiguo o el peso está cortado/ilegible, "medium" si interpretaste con supuestos razonables, "high" si es inequívoco.
3. Las líneas "2 X 3,99" u similares son multiplicadores de cantidad de la línea de producto ADYACENTE (arriba o abajo), no productos en sí — no las devuelvas como item aparte.

   Ejemplo concreto de este patrón:
   Ticket dice:
     "2   X   3,99"
     "HAMBU SCOT BACON G18          7,98"
   Esto significa: 2 unidades a €3,99 cada una = €7,98 total. El "G18" al final del
   nombre es parte del código interno de producto, NO es una cantidad en gramos —
   nunca lo confundas con peso. Respuesta correcta para esta línea:
     { "raw_name": "HAMBU SCOT BACON G18", "quantity": 2, "unit": "unit",
       "line_total": 7.98, "unit_price": 3.99, ... }
   Respuesta INCORRECTA (no hagas esto): interpretar "G18" como quantity=18, unit="g".

   Regla general: un número pegado al final de un nombre de producto (como "G18",
   "R74", "C18") casi siempre es parte de un código interno, NO un peso o cantidad,
   salvo que esté precedido explícitamente por "GR" + número seguido de espacio o
   fin de palabra (ej "GR125", "GR200").

4. Los descuentos ("Sconto", "Descuento") no son items — sumalos todos en discounts_total (como número positivo).
5. purchase_date en formato ISO 8601 si podés leerlo, si no null.
6. Si un campo no se puede determinar, usá null — nunca inventes valores.

Estructura exacta de respuesta:
{
  "merchant": string | null,
  "purchase_date": string | null,
  "currency": string,
  "items": [ { "raw_name": string, "display_name": string, "quantity": number|null, "unit": string|null, "line_total": number, "unit_price": number|null, "category": string, "is_food": boolean, "confidence": string } ],
  "discounts_total": number | null,
  "total": number | null
}`;
}

export async function parseReceipt(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  targetLanguage: string = "es"
): Promise<ReceiptParseResult> {
  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001", // suficiente para esta tarea, barato
    // 4096 alcanzaba para tickets de ~20 productos, pero uno con 40+ (como
    // los de supermercado grande) lo superaba y la respuesta quedaba cortada
    // a mitad de un objeto JSON. Subimos el techo con margen.
    max_tokens: 8192,
    temperature: 0, // reduce (no elimina) la variabilidad entre llamadas idénticas
    system: buildSystemPrompt(targetLanguage),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: imageBase64,
            },
          },
          {
            type: "text",
            text: "Extraé los datos de este ticket siguiendo exactamente las reglas indicadas.",
          },
        ],
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("La respuesta no contiene el bloque de texto esperado");
  }

  if (message.stop_reason === "max_tokens") {
    throw new Error(
      `La respuesta se cortó por límite de tokens (max_tokens: ${8192}). ` +
        `El ticket probablemente tiene demasiados productos — subí max_tokens en receiptParser.ts.`
    );
  }

  // El modelo puede a veces envolver en ```json a pesar de la instrucción;
  // lo limpiamos por las dudas antes de parsear.
  const clean = textBlock.text.replace(/```json|```/g, "").trim();

  let parsed: ReceiptParseResult;
  try {
    parsed = JSON.parse(clean) as ReceiptParseResult;
  } catch (err) {
    throw new Error(`No se pudo parsear la respuesta como JSON: ${clean}`);
  }

  parsed.checksum_ok = computeChecksum(parsed);
  return parsed;
}

// Verifica que suma(line_total) - discounts_total ≈ total.
// Si no coincide, hay al menos un error de lectura en algún ítem, aunque
// el modelo lo haya marcado con confidence alta — encontramos este caso
// real probando con un ticket de Carrefour (ver conversación de prueba).
function computeChecksum(result: ReceiptParseResult): boolean | null {
  if (result.total === null) return null;
  if (result.items.some((i) => i.line_total === null)) return null;

  const itemsSum = result.items.reduce((acc, i) => acc + i.line_total, 0);
  const discounts = result.discounts_total ?? 0;
  const expected = itemsSum - discounts;

  return Math.abs(expected - result.total) < 0.01;
}
