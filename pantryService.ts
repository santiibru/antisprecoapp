/**
 * pantryService.ts
 *
 * Operaciones sobre la alacena que van a ser llamadas desde la UI.
 *
 * mergePantryItems: el usuario decide que dos filas son en realidad el
 * mismo producto (típicamente porque la IA lo nombró distinto entre dos
 * escaneos, ej. "Sottilette Burger" vs "Queso Sottilette Burger") y las
 * quiere unificar en una sola con la cantidad sumada.
 */

import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { pantryItems, receiptItems, pantryConsumptionEvents } from "./schema";
import { estimateExpiration } from "./receiptService";
import type { ReceiptItem } from "./receiptParser";

export type ManualPantryItemInput = {
  displayName: string;
  quantity: number;
  unit: "g" | "kg" | "ml" | "l" | "unit";
  category: ReceiptItem["category"];
  purchaseDate?: Date;
  // Si el usuario no la especifica, se estima según categoría (igual que al escanear un ticket).
  estimatedExpirationDate?: Date | null;
};

/**
 * Alta manual de un producto en la alacena — mismo camino que un item de
 * ticket con is_food=true (ver receiptService.saveReceipt), para que la
 * alacena se comporte igual sin importar de dónde vino el producto: si ya
 * existe uno con el mismo nombre y unidad, suma cantidades en vez de
 * duplicar la fila.
 */
export async function addManualPantryItem(
  userId: string,
  input: ManualPantryItemInput
) {
  const purchaseDate = input.purchaseDate ?? new Date();
  const estimatedExpirationDate =
    input.estimatedExpirationDate !== undefined
      ? input.estimatedExpirationDate
      : estimateExpiration(input.category, purchaseDate);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(pantryItems)
      .where(
        and(
          eq(pantryItems.userId, userId),
          eq(pantryItems.displayName, input.displayName),
          eq(pantryItems.unit, input.unit)
        )
      )
      .limit(1);

    if (existing) {
      const newQuantity = Number(existing.quantity) + input.quantity;
      const [updated] = await tx
        .update(pantryItems)
        .set({
          quantity: newQuantity.toString(),
          estimatedExpirationDate,
          updatedAt: new Date(),
        })
        .where(eq(pantryItems.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await tx
      .insert(pantryItems)
      .values({
        userId,
        displayName: input.displayName,
        quantity: input.quantity.toString(),
        unit: input.unit,
        category: input.category,
        purchaseDate,
        estimatedExpirationDate,
        addedManually: true,
      })
      .returning();
    return created;
  });
}

export class MergeUnitMismatchError extends Error {
  constructor(unitA: string, unitB: string) {
    super(
      `No se pueden fusionar automáticamente: unidades distintas (${unitA} vs ${unitB}). Convertí una de las dos a mano antes de fusionar.`
    );
  }
}

/**
 * Fusiona `sourceId` dentro de `targetId`: suma las cantidades (si la unidad
 * coincide), reasigna el historial de receiptItems que apuntaba a `sourceId`,
 * y borra la fila sobrante.
 *
 * El "target" sobrevive — pensalo como "fusionar A dentro de B".
 */
export async function mergePantryItems(
  userId: string,
  sourceId: string,
  targetId: string
) {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(pantryItems)
      .where(eq(pantryItems.id, sourceId))
      .limit(1);
    const [target] = await tx
      .select()
      .from(pantryItems)
      .where(eq(pantryItems.id, targetId))
      .limit(1);

    if (!source || !target) {
      throw new Error("Alguno de los dos productos no existe");
    }
    if (source.userId !== userId || target.userId !== userId) {
      throw new Error("No autorizado: el producto no pertenece a este usuario");
    }
    if (source.unit !== target.unit) {
      throw new MergeUnitMismatchError(source.unit, target.unit);
    }

    const newQuantity = Number(source.quantity) + Number(target.quantity);

    const [updated] = await tx
      .update(pantryItems)
      .set({ quantity: newQuantity.toString(), updatedAt: new Date() })
      .where(eq(pantryItems.id, targetId))
      .returning();

    // Preservamos el historial: los receiptItems que apuntaban a `source`
    // ahora apuntan a `target`, así no se pierde de qué ticket vino cada uno.
    await tx
      .update(receiptItems)
      .set({ pantryItemId: targetId })
      .where(eq(receiptItems.pantryItemId, sourceId));

    await tx.delete(pantryItems).where(eq(pantryItems.id, sourceId));

    return updated;
  });
}

export class InsufficientQuantityError extends Error {
  constructor(available: number, requested: number) {
    super(
      `Solo hay ${available} disponible, no se pueden restar ${requested}.`
    );
  }
}

/**
 * Resta cantidad de un producto porque se consumió o se tiró, y deja
 * registro del evento (para poder medir desperdicio real más adelante).
 * Si la cantidad restante llega a 0, se borra la fila de la alacena —
 * ya no hay nada de ese producto para mostrar.
 */
export async function consumePantryItem(
  userId: string,
  pantryItemId: string,
  quantity: number,
  eventType: "consumed" | "discarded"
) {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(pantryItems)
      .where(eq(pantryItems.id, pantryItemId))
      .limit(1);

    if (!item) {
      throw new Error("Producto no encontrado");
    }
    if (item.userId !== userId) {
      throw new Error("No autorizado: el producto no pertenece a este usuario");
    }

    const currentQuantity = Number(item.quantity);
    if (quantity > currentQuantity) {
      throw new InsufficientQuantityError(currentQuantity, quantity);
    }

    // El evento queda registrado siempre, se borre o no la fila después —
    // es el dato que alimenta cualquier reporte de desperdicio a futuro.
    await tx.insert(pantryConsumptionEvents).values({
      userId,
      pantryItemId: item.id,
      displayName: item.displayName,
      quantity: quantity.toString(),
      unit: item.unit,
      category: item.category,
      eventType,
    });

    const remaining = currentQuantity - quantity;

    if (remaining <= 0) {
      await tx.delete(pantryItems).where(eq(pantryItems.id, item.id));
      return { deleted: true, remaining: 0 };
    }

    const [updated] = await tx
      .update(pantryItems)
      .set({ quantity: remaining.toString(), updatedAt: new Date() })
      .where(eq(pantryItems.id, item.id))
      .returning();

    return { deleted: false, remaining, item: updated };
  });
}
