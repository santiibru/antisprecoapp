/**
 * receiptService.ts
 *
 * Toma el resultado de parseReceipt (receiptParser.ts) y lo persiste:
 * 1. Crea el registro en `receipts` (metadata + JSON crudo de auditoría)
 * 2. Crea un `receiptItems` por cada línea devuelta por la IA (inmutable)
 * 3. Para cada ítem con is_food=true, crea (o suma a) un `pantryItems`
 *    con vencimiento estimado según categoría
 *
 * No borra ni sobreescribe receiptItems — esa tabla es el historial fiel
 * de lo que la IA devolvió, tal como se explicó en el diseño del schema.
 */

import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { receipts, receiptItems, pantryItems } from "./schema";
import type { ReceiptParseResult, ReceiptItem } from "./receiptParser";

// Vida útil estimada por categoría, en días desde la fecha de compra.
// Son valores de arranque razonables, no exactos — el usuario puede corregir
// la fecha a mano en cualquier momento desde la UI.
export const SHELF_LIFE_DAYS: Record<ReceiptItem["category"], number | null> = {
  produce: 7,
  dairy: 10,
  bakery: 5,
  meat_fish: 4,
  pantry: 180,
  beverages: 90,
  snacks: 60,
  cleaning: null, // no aplica vencimiento relevante
  personal_care: null,
  other: null,
};

export function estimateExpiration(
  category: ReceiptItem["category"],
  purchaseDate: Date
): Date | null {
  const days = SHELF_LIFE_DAYS[category];
  if (days === null) return null;
  const expiration = new Date(purchaseDate);
  expiration.setDate(expiration.getDate() + days);
  return expiration;
}

export async function saveReceipt(
  userId: string,
  parsed: ReceiptParseResult
) {
  const purchaseDate = parsed.purchase_date
    ? new Date(parsed.purchase_date)
    : new Date(); // si la IA no pudo leer la fecha, usamos "ahora" como mejor estimación

  // Insertamos todo en una transacción: si algo falla a mitad de camino,
  // no queremos un receipt sin sus items, o items sin su pantryItem.
  return db.transaction(async (tx) => {
    const [receipt] = await tx
      .insert(receipts)
      .values({
        userId,
        merchant: parsed.merchant,
        purchaseDate,
        currency: parsed.currency,
        discountsTotal: parsed.discounts_total?.toString(),
        total: parsed.total?.toString(),
        checksumOk: parsed.checksum_ok,
        rawResponse: JSON.stringify(parsed),
      })
      .returning();

    const createdPantryItems = [];
    const itemResults: { pantryItemId: string | null; finalQuantity: number | null }[] = [];

    for (const item of parsed.items) {
      let pantryItemId: string | null = null;
      let finalQuantity: number | null = null;

      // Solo generamos/actualizamos pantryItem para productos que son comida.
      // Los que no lo son (limpieza, higiene) quedan solo en receiptItems
      // como registro histórico del gasto, pero no ensucian la alacena.
      if (item.is_food) {
        const unit = item.unit ?? "unit";
        const quantity = item.quantity ?? 1;

        // Buscamos si ya existe este producto en la alacena del usuario,
        // con la misma unidad (no tiene sentido sumar "2 g" + "1 unit").
        // Coincidencia por nombre exacto por ahora — es un punto de mejora
        // a futuro (ej. normalizar mayúsculas/acentos, o usar un catálogo
        // de productos en vez de comparar strings).
        const [existing] = await tx
          .select()
          .from(pantryItems)
          .where(
            and(
              eq(pantryItems.userId, userId),
              eq(pantryItems.displayName, item.display_name),
              eq(pantryItems.unit, unit)
            )
          )
          .limit(1);

        if (existing) {
          const newQuantity = Number(existing.quantity) + quantity;
          console.log(
            `[merge] "${item.display_name}" (unit: ${unit}) — existente: ${existing.quantity}, este escaneo: ${quantity}, resultado: ${newQuantity}`
          );
          const [updated] = await tx
            .update(pantryItems)
            .set({
              quantity: newQuantity.toString(),
              // El vencimiento se actualiza al de la compra más reciente,
              // asumiendo que lo nuevo se consume después de lo viejo.
              estimatedExpirationDate: estimateExpiration(
                item.category,
                purchaseDate
              ),
              updatedAt: new Date(),
            })
            .where(eq(pantryItems.id, existing.id))
            .returning();

          pantryItemId = updated.id;
          finalQuantity = Number(updated.quantity);
          createdPantryItems.push(updated);
        } else {
          console.log(
            `[merge] "${item.display_name}" (unit: ${unit}) — no existía, se crea nuevo con cantidad ${quantity}`
          );
          const [pantryItem] = await tx
            .insert(pantryItems)
            .values({
              userId,
              displayName: item.display_name,
              quantity: quantity.toString(),
              unit,
              category: item.category,
              purchaseDate,
              estimatedExpirationDate: estimateExpiration(
                item.category,
                purchaseDate
              ),
              addedManually: false,
            })
            .returning();

          pantryItemId = pantryItem.id;
          finalQuantity = Number(pantryItem.quantity);
          createdPantryItems.push(pantryItem);
        }
      }

      await tx.insert(receiptItems).values({
        receiptId: receipt.id,
        rawName: item.raw_name,
        displayNameOriginal: item.display_name,
        quantity: item.quantity?.toString(),
        unit: item.unit,
        lineTotal: item.line_total?.toString(),
        unitPrice: item.unit_price?.toString(),
        category: item.category,
        isFood: item.is_food,
        confidence: item.confidence,
        pantryItemId,
      });

      itemResults.push({ pantryItemId, finalQuantity });
    }

    return {
      receipt,
      pantryItemsCreated: createdPantryItems.length,
      itemResults,
    };
  });
}
