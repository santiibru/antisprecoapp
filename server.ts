/**
 * server.ts
 *
 * Servidor Express mínimo para probar el flujo completo desde afuera
 * (curl, Postman, o más adelante el frontend real).
 *
 * Endpoints:
 *   POST /api/receipts  — sube una foto de ticket (multipart, campo "image")
 *                          y devuelve el resultado parseado + guardado
 *   GET  /api/pantry     — devuelve la alacena del usuario de prueba
 *   /api/shopping-list    — lista de compras (CRUD + sugerencias de la IA)
 *
 * Por ahora usa un userId fijo (no hay auth todavía) — ver TEST_USER_ID.
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import { eq } from "drizzle-orm";
import { parseReceipt } from "./receiptParser";
import { saveReceipt } from "./receiptService";
import { mergePantryItems, consumePantryItem, addManualPantryItem } from "./pantryService";
import { suggestRecipes } from "./recipeService";
import {
  listShoppingItems,
  addShoppingItem,
  updateShoppingItem,
  deleteShoppingItem,
  moveCheckedToPantry,
  suggestShoppingItems,
} from "./shoppingListService";
import { db } from "./db";
import { pantryItems } from "./schema";

const app = express();

// El frontend (Vite) corre en un puerto distinto (5173) al backend (3001),
// así que el navegador bloquea los pedidos por CORS a menos que el backend
// los permita explícitamente. Para desarrollo local alcanza con esto; en
// producción conviene restringir "origin" al dominio real del frontend.
app.use(cors());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB, de sobra para una foto de ticket
});

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

app.post("/api/receipts", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Falta el archivo (campo 'image')" });
    }

    const targetLanguage = (req.query.lang as string) ?? "es";
    const mediaType = req.file.mimetype as "image/jpeg" | "image/png" | "image/webp";
    const imageBase64 = req.file.buffer.toString("base64");

    const parsed = await parseReceipt(imageBase64, mediaType, targetLanguage);
    const { receipt, pantryItemsCreated, itemResults } = await saveReceipt(
      TEST_USER_ID,
      parsed
    );

    // Combinamos cada item parseado con el id real y la CANTIDAD FINAL ya
    // sumada en la alacena (no la cruda de este escaneo) — así el frontend
    // puede editar/guardar sin pisar accidentalmente el merge automático.
    const itemsWithIds = parsed.items.map((item, i) => ({
      ...item,
      pantryItemId: itemResults[i]?.pantryItemId ?? null,
      finalQuantity: itemResults[i]?.finalQuantity ?? item.quantity,
    }));

    res.json({
      receiptId: receipt.id,
      checksumOk: parsed.checksum_ok,
      itemsDetected: parsed.items.length,
      pantryItemsUpdated: pantryItemsCreated,
      items: itemsWithIds,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/pantry", async (_req, res) => {
  const items = await db
    .select()
    .from(pantryItems)
    .where(eq(pantryItems.userId, TEST_USER_ID));

  res.json(items);
});

const FOOD_CATEGORIES = [
  "produce",
  "dairy",
  "bakery",
  "meat_fish",
  "pantry",
  "beverages",
  "snacks",
  "cleaning",
  "personal_care",
  "other",
];
const UNITS = ["g", "kg", "ml", "l", "unit"];

// Alta manual de un producto — mismas columnas que un item generado por
// escaneo de ticket (nombre, cantidad, unidad, categoría), para que la
// alacena no distinga de dónde vino el producto.
app.post("/api/pantry", express.json(), async (req, res) => {
  try {
    const { displayName, quantity, unit, category, purchaseDate, estimatedExpirationDate } = req.body;

    if (!displayName || typeof displayName !== "string") {
      return res.status(400).json({ error: "Falta 'displayName' (texto)" });
    }
    if (quantity === undefined || Number(quantity) <= 0) {
      return res.status(400).json({ error: "'quantity' debe ser un número mayor a 0" });
    }
    if (!UNITS.includes(unit)) {
      return res.status(400).json({ error: `'unit' debe ser uno de: ${UNITS.join(", ")}` });
    }
    if (!FOOD_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `'category' debe ser una de: ${FOOD_CATEGORIES.join(", ")}` });
    }

    const created = await addManualPantryItem(TEST_USER_ID, {
      displayName,
      quantity: Number(quantity),
      unit,
      category,
      purchaseDate: purchaseDate ? new Date(purchaseDate) : undefined,
      estimatedExpirationDate:
        estimatedExpirationDate !== undefined
          ? estimatedExpirationDate
            ? new Date(estimatedExpirationDate)
            : null
          : undefined,
    });

    res.status(201).json(created);
  } catch (err) {
    console.error("[POST /api/pantry]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// El usuario corrige cantidad/unidad/nombre a mano después del escaneo.
app.patch("/api/pantry/:id", express.json(), async (req, res) => {
  try {
    const { quantity, unit, displayName } = req.body;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (quantity !== undefined) updates.quantity = String(quantity);
    if (unit !== undefined) updates.unit = unit;
    if (displayName !== undefined) updates.displayName = displayName;

    const [updated] = await db
      .update(pantryItems)
      .set(updates)
      .where(eq(pantryItems.id, req.params.id))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Producto no encontrado" });
    }

    res.json(updated);
  } catch (err) {
    console.error("[PATCH /api/pantry/:id]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// El usuario decide que dos filas son en realidad el mismo producto
// (la IA las nombró distinto entre dos escaneos) y las fusiona en una.
app.post("/api/pantry/merge", express.json(), async (req, res) => {
  try {
    const { sourceId, targetId } = req.body;
    if (!sourceId || !targetId) {
      return res.status(400).json({ error: "Faltan sourceId o targetId" });
    }

    const updated = await mergePantryItems(TEST_USER_ID, sourceId, targetId);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// El usuario marca que consumió o tiró cierta cantidad de un producto.
app.post("/api/pantry/:id/consume", express.json(), async (req, res) => {
  try {
    const { quantity, eventType } = req.body;
    if (!quantity || (eventType !== "consumed" && eventType !== "discarded")) {
      return res.status(400).json({
        error: "Faltan 'quantity' (número > 0) o 'eventType' ('consumed'|'discarded')",
      });
    }

    const result = await consumePantryItem(
      TEST_USER_ID,
      req.params.id,
      Number(quantity),
      eventType
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Sugerencias de recetas priorizando lo que está por vencer. Se pide
// explícitamente (no en cada carga de la alacena) porque cada llamada
// cuesta una consulta a la IA.
app.get("/api/recipes", async (req, res) => {
  try {
    const lang = (req.query.lang as string) ?? "es";
    const recipes = await suggestRecipes(TEST_USER_ID, lang);
    res.json({ recipes });
  } catch (err) {
    console.error("[GET /api/recipes]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---- Lista de compras ----

app.get("/api/shopping-list", async (_req, res) => {
  try {
    res.json(await listShoppingItems(TEST_USER_ID));
  } catch (err) {
    console.error("[GET /api/shopping-list]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/shopping-list", express.json(), async (req, res) => {
  try {
    const { displayName, quantity, unit, category, suggestedByAi } = req.body;

    if (!displayName || typeof displayName !== "string" || !displayName.trim()) {
      return res.status(400).json({ error: "Falta 'displayName' (texto)" });
    }
    if (quantity != null && quantity !== "" && Number(quantity) <= 0) {
      return res.status(400).json({ error: "'quantity' debe ser un número mayor a 0" });
    }
    if (unit != null && !UNITS.includes(unit)) {
      return res.status(400).json({ error: `'unit' debe ser uno de: ${UNITS.join(", ")}` });
    }
    if (!FOOD_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `'category' debe ser una de: ${FOOD_CATEGORIES.join(", ")}` });
    }

    const created = await addShoppingItem(TEST_USER_ID, {
      displayName: displayName.trim(),
      quantity: quantity != null && quantity !== "" ? Number(quantity) : null,
      unit: unit ?? null,
      category,
      suggestedByAi: Boolean(suggestedByAi),
    });
    res.status(201).json(created);
  } catch (err) {
    console.error("[POST /api/shopping-list]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Sugerencias de la IA según lo que el usuario consume seguido y ya se
// terminó. Igual que las recetas, se pide explícitamente porque cuesta una
// consulta a la IA. Va antes de las rutas con :id para que no las pise.
app.get("/api/shopping-list/suggestions", async (req, res) => {
  try {
    const lang = (req.query.lang as string) ?? "es";
    const suggestions = await suggestShoppingItems(TEST_USER_ID, lang);
    res.json({ suggestions });
  } catch (err) {
    console.error("[GET /api/shopping-list/suggestions]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Al volver del super: lo tildado pasa a la alacena y sale de la lista.
app.post("/api/shopping-list/move-checked", async (_req, res) => {
  try {
    res.json(await moveCheckedToPantry(TEST_USER_ID));
  } catch (err) {
    console.error("[POST /api/shopping-list/move-checked]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.patch("/api/shopping-list/:id", express.json(), async (req, res) => {
  try {
    const { checked, displayName } = req.body;
    const updates: { checked?: boolean; displayName?: string } = {};
    if (typeof checked === "boolean") updates.checked = checked;
    if (typeof displayName === "string" && displayName.trim()) updates.displayName = displayName.trim();

    const updated = await updateShoppingItem(TEST_USER_ID, req.params.id, updates);
    if (!updated) {
      return res.status(404).json({ error: "Producto no encontrado en la lista" });
    }
    res.json(updated);
  } catch (err) {
    console.error("[PATCH /api/shopping-list/:id]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/shopping-list/:id", async (req, res) => {
  try {
    await deleteShoppingItem(TEST_USER_ID, req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error("[DELETE /api/shopping-list/:id]", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`Servidor de prueba corriendo en http://localhost:${PORT}`);
});
