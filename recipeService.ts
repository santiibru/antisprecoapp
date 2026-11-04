/**
 * recipeService.ts
 *
 * Genera sugerencias de recetas con la IA a partir de lo que hay en la
 * alacena, priorizando los productos que están por vencer — es la pieza
 * que le da sentido real al "anti-desperdicio": no es "recetas con lo que
 * tengo" genérico, es "usá esto antes de que se eche a perder".
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { pantryItems } from "./schema";

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type RecipeSuggestion = {
  title: string;
  usesExpiringSoon: boolean; // true si aprovecha al menos un producto que vence en ≤3 días
  usedIngredients: string[]; // nombres tal como están en la alacena (displayName)
  missingIngredients: string[]; // cosas que la receta necesita y no están en la alacena
  instructions: string[]; // pasos cortos
};

function buildPrompt(targetLanguage: string): string {
  return `Sos un asistente de cocina que sugiere recetas para aprovechar lo que la persona ya tiene en su alacena, priorizando lo que está por vencer para evitar desperdicio de comida.

Te paso una lista de productos disponibles, cada uno con su cantidad y los días que le quedan antes de vencer (un número negativo significa que ya venció).

Reglas:
1. Respondé ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin markdown ni backticks.
2. Sugerí entre 3 y 5 recetas realistas y simples, en el idioma "${targetLanguage}".
3. Priorizá recetas que usen productos con 3 días o menos para vencer — marcalas con usesExpiringSoon: true.
4. usedIngredients: solo nombres que aparecen EXACTAMENTE en la lista que te paso (copiá el nombre tal cual).
5. missingIngredients: cosas que la receta necesita pero no están en la lista (está bien asumir que hay sal, aceite, agua — no las incluyas ahí).
6. instructions: 3 a 6 pasos cortos, uno por elemento del array.
7. No repitas la misma receta dos veces. No sugieras recetas con productos que no son comida.

Estructura exacta de respuesta:
{ "recipes": [ { "title": string, "usesExpiringSoon": boolean, "usedIngredients": string[], "missingIngredients": string[], "instructions": string[] } ] }`;
}

export async function suggestRecipes(
  userId: string,
  targetLanguage: string = "es"
): Promise<RecipeSuggestion[]> {
  const items = await db.select().from(pantryItems).where(eq(pantryItems.userId, userId));

  const foodItems = items.filter((i) => i.category !== "cleaning" && i.category !== "personal_care" && i.category !== "other");

  if (foodItems.length === 0) {
    return [];
  }

  const now = Date.now();
  const ingredientList = foodItems
    .map((item) => {
      const daysLeft = item.estimatedExpirationDate
        ? Math.ceil((new Date(item.estimatedExpirationDate).getTime() - now) / 86400000)
        : null;
      const expiryNote = daysLeft === null ? "sin vencimiento estimado" : `vence en ${daysLeft} días`;
      return `- ${item.displayName}: ${item.quantity} ${item.unit} (${expiryNote})`;
    })
    .join("\n");

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    temperature: 0.7, // acá sí queremos variedad creativa, a diferencia del parseo de tickets
    system: buildPrompt(targetLanguage),
    messages: [{ role: "user", content: `Alacena disponible:\n${ingredientList}` }],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("La respuesta no contiene el bloque de texto esperado");
  }

  if (message.stop_reason === "max_tokens") {
    throw new Error("La respuesta de recetas se cortó por límite de tokens — subí max_tokens en recipeService.ts");
  }

  const clean = textBlock.text.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(clean) as { recipes: RecipeSuggestion[] };
    return parsed.recipes;
  } catch {
    throw new Error(`No se pudo parsear la respuesta de recetas como JSON: ${clean}`);
  }
}
