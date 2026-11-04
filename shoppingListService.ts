/**
 * shoppingListService.ts
 *
 * Lista de compras del usuario + sugerencias de la IA.
 *
 * Las sugerencias salen del historial de consumo (pantryConsumptionEvents):
 * lo que la persona consume seguido y ya no tiene (o le queda poco) en la
 * alacena es lo más probable que necesite reponer. La IA además puede
 * proponer algún producto nuevo que combine con esos hábitos.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "./db";
import { pantryConsumptionEvents, pantryItems, shoppingListItems } from "./schema";
import { addManualPantryItem } from "./pantryService";
import type { ReceiptItem } from "./receiptParser";

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

type Unit = "g" | "kg" | "ml" | "l" | "unit";

export type ShoppingListItemInput = {
  displayName: string;
  quantity?: number | null;
  unit?: Unit | null;
  category: ReceiptItem["category"];
  suggestedByAi?: boolean;
};

export type ShoppingSuggestion = {
  displayName: string;
  category: ReceiptItem["category"];
  quantity: number | null;
  unit: Unit | null;
  reason: string; // explicación corta para mostrarle al usuario
};

// Ventana de historial que miramos para detectar hábitos de consumo.
const HISTORY_DAYS = 90;

export async function listShoppingItems(userId: string) {
  return db
    .select()
    .from(shoppingListItems)
    .where(eq(shoppingListItems.userId, userId))
    .orderBy(asc(shoppingListItems.createdAt));
}

export async function addShoppingItem(userId: string, input: ShoppingListItemInput) {
  const [created] = await db
    .insert(shoppingListItems)
    .values({
      userId,
      displayName: input.displayName,
      quantity: input.quantity != null ? input.quantity.toString() : null,
      unit: input.unit ?? null,
      category: input.category,
      suggestedByAi: input.suggestedByAi ?? false,
    })
    .returning();
  return created;
}

export async function updateShoppingItem(
  userId: string,
  id: string,
  updates: { checked?: boolean; displayName?: string }
) {
  const [updated] = await db
    .update(shoppingListItems)
    .set(updates)
    .where(and(eq(shoppingListItems.id, id), eq(shoppingListItems.userId, userId)))
    .returning();
  return updated;
}

export async function deleteShoppingItem(userId: string, id: string) {
  await db
    .delete(shoppingListItems)
    .where(and(eq(shoppingListItems.id, id), eq(shoppingListItems.userId, userId)));
}

/**
 * Pasa a la alacena todo lo tildado como comprado y lo saca de la lista.
 * Si el ítem no tenía cantidad, entra como 1 unidad — el usuario la puede
 * corregir desde la alacena con "Editar".
 */
export async function moveCheckedToPantry(userId: string) {
  const checked = await db
    .select()
    .from(shoppingListItems)
    .where(and(eq(shoppingListItems.userId, userId), eq(shoppingListItems.checked, true)));

  for (const item of checked) {
    await addManualPantryItem(userId, {
      displayName: item.displayName,
      quantity: item.quantity ? Number(item.quantity) : 1,
      unit: item.unit ?? "unit",
      category: item.category,
    });
    await db.delete(shoppingListItems).where(eq(shoppingListItems.id, item.id));
  }

  return { moved: checked.length };
}

function buildSuggestionPrompt(targetLanguage: string): string {
  return `Sos un asistente que ayuda a armar la lista de compras de una persona a partir de sus hábitos de consumo, para que no se quede sin lo que usa seguido y a la vez no compre de más (la app es anti-desperdicio).

Te paso tres listas:
1. Historial de consumo de los últimos ${HISTORY_DAYS} días: cada producto con cuántas veces lo consumió, cuánto en total y hace cuántos días fue la última vez.
2. Lo que hay ahora en la alacena, con cantidad.
3. Lo que ya está en la lista de compras.

Reglas:
1. Respondé ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin markdown ni backticks.
2. Sugerí entre 3 y 8 productos, en el idioma "${targetLanguage}".
3. Priorizá lo que la persona consume seguido y ya no está en la alacena (o queda muy poco). Esas son las sugerencias más valiosas.
4. Podés sumar como mucho 2 productos nuevos que no aparecen en el historial pero combinan con lo que consume habitualmente.
5. No sugieras nada que ya esté en la lista de compras, ni algo que en la alacena haya en cantidad suficiente.
6. No sugieras cosas que la persona tiró (el historial solo incluye lo consumido).
7. displayName: si el producto viene del historial, copiá el nombre tal cual.
8. category: una de produce, dairy, bakery, meat_fish, pantry, beverages, snacks, cleaning, personal_care, other.
9. quantity y unit: una cantidad razonable para reponer según lo que suele consumir; unit es una de g, kg, ml, l, unit. Si no sabés, usá null en los dos.
10. reason: una frase corta y concreta (ej. "Lo consumiste 4 veces este mes y se terminó").
11. Si el historial está vacío, devolvé { "suggestions": [] }.

Estructura exacta de respuesta:
{ "suggestions": [ { "displayName": string, "category": string, "quantity": number | null, "unit": string | null, "reason": string } ] }`;
}

export async function suggestShoppingItems(
  userId: string,
  targetLanguage: string = "es"
): Promise<ShoppingSuggestion[]> {
  const since = new Date(Date.now() - HISTORY_DAYS * 86400000);

  const [events, pantry, list] = await Promise.all([
    db
      .select()
      .from(pantryConsumptionEvents)
      .where(
        and(
          eq(pantryConsumptionEvents.userId, userId),
          eq(pantryConsumptionEvents.eventType, "consumed"),
          gte(pantryConsumptionEvents.createdAt, since)
        )
      ),
    db.select().from(pantryItems).where(eq(pantryItems.userId, userId)),
    db.select().from(shoppingListItems).where(eq(shoppingListItems.userId, userId)),
  ]);

  if (events.length === 0) {
    return [];
  }

  // Agrupamos por nombre+unidad: cada evento es un "Consumí" de la alacena.
  const now = Date.now();
  const habits = new Map<string, { name: string; unit: string; times: number; total: number; lastMs: number }>();
  for (const e of events) {
    const key = `${e.displayName.toLowerCase()}|${e.unit}`;
    const created = new Date(e.createdAt).getTime();
    const h = habits.get(key) ?? { name: e.displayName, unit: e.unit, times: 0, total: 0, lastMs: 0 };
    h.times += 1;
    h.total += Number(e.quantity);
    h.lastMs = Math.max(h.lastMs, created);
    habits.set(key, h);
  }

  const historyText = [...habits.values()]
    .sort((a, b) => b.times - a.times)
    .map(
      (h) =>
        `- ${h.name}: ${h.times} veces, ${h.total} ${h.unit} en total, última vez hace ${Math.floor((now - h.lastMs) / 86400000)} días`
    )
    .join("\n");
  const pantryText =
    pantry.map((p) => `- ${p.displayName}: ${Number(p.quantity)} ${p.unit}`).join("\n") || "(vacía)";
  const listText = list.map((i) => `- ${i.displayName}`).join("\n") || "(vacía)";

  const message = await anthropic.beta.messages.create({
    model: "claude-opus-5",
    max_tokens: 16000,
    output_config: { effort: "low" }, // tarea simple de ordenar y elegir, no hace falta pensar mucho
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: buildSuggestionPrompt(targetLanguage),
    messages: [
      {
        role: "user",
        content: `Historial de consumo:\n${historyText}\n\nAlacena actual:\n${pantryText}\n\nLista de compras actual:\n${listText}`,
      },
    ],
  });

  if (message.stop_reason === "refusal") {
    throw new Error("La IA no pudo generar sugerencias esta vez, probá de nuevo");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("La respuesta de sugerencias se cortó por límite de tokens — subí max_tokens en shoppingListService.ts");
  }

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("La respuesta no contiene el bloque de texto esperado");
  }

  const clean = textBlock.text.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(clean) as { suggestions: ShoppingSuggestion[] };
    // Filtro de seguridad por si la IA igual repite algo que ya está en la lista.
    const onList = new Set(list.map((i) => i.displayName.toLowerCase()));
    return parsed.suggestions.filter((s) => !onList.has(s.displayName.toLowerCase()));
  } catch {
    throw new Error(`No se pudo parsear la respuesta de sugerencias como JSON: ${clean}`);
  }
}
