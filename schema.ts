/**
 * schema.ts
 *
 * Esquema de Drizzle para Postgres (Supabase/Neon).
 *
 * Diseño en dos tablas principales:
 * - receipts: un registro por ticket escaneado (metadata del comercio/compra)
 * - pantryItems: un registro por producto — vive independiente del ticket
 *   una vez creado, porque su cantidad va a cambiar con el tiempo (se consume,
 *   se repone) y no siempre viene de un escaneo (alta manual también).
 *
 * receiptItems queda como tabla de auditoría/trazabilidad: qué devolvió la IA
 * tal cual, antes de que el usuario lo corrija. Separarla de pantryItems es
 * clave: así nunca perdés el dato crudo original aunque el usuario edite la
 * cantidad a mano después.
 */

import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  boolean,
  pgEnum,
  integer,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ---- Enums (capa técnica: siempre en inglés) ----

export const foodCategoryEnum = pgEnum("food_category", [
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
]);

export const unitEnum = pgEnum("unit", ["g", "kg", "ml", "l", "unit"]);

export const confidenceEnum = pgEnum("confidence", ["low", "medium", "high"]);

// "consumed" = lo usaste (bien); "discarded" = lo tiraste (el dato que
// realmente le da sentido a la app anti-desperdicio, se acumula con el tiempo
// para poder mostrar reportes tipo "este mes tiraste X de verdura").
export const consumptionEventTypeEnum = pgEnum("consumption_event_type", [
  "consumed",
  "discarded",
]);

// ---- receipts ----

export const receipts = pgTable("receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(), // FK a tu tabla de usuarios existente
  merchant: text("merchant"),
  purchaseDate: timestamp("purchase_date", { withTimezone: true }),
  currency: text("currency").notNull().default("EUR"),
  discountsTotal: numeric("discounts_total", { precision: 10, scale: 2 }),
  total: numeric("total", { precision: 10, scale: 2 }),
  checksumOk: boolean("checksum_ok"), // resultado de nuestra validación matemática
  rawResponse: text("raw_response"), // JSON completo devuelto por la API, sin tocar
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---- receiptItems (auditoría — lo que devolvió la IA, inmutable) ----

export const receiptItems = pgTable("receipt_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  receiptId: uuid("receipt_id")
    .notNull()
    .references(() => receipts.id, { onDelete: "cascade" }),
  rawName: text("raw_name").notNull(), // texto exacto del ticket, nunca se edita
  displayNameOriginal: text("display_name_original").notNull(), // lo que devolvió la IA antes de cualquier corrección del usuario
  quantity: numeric("quantity", { precision: 10, scale: 3 }),
  unit: unitEnum("unit"),
  lineTotal: numeric("line_total", { precision: 10, scale: 2 }),
  unitPrice: numeric("unit_price", { precision: 10, scale: 2 }),
  category: foodCategoryEnum("category").notNull(),
  isFood: boolean("is_food").notNull().default(true),
  confidence: confidenceEnum("confidence").notNull(),
  // Si esto generó un pantryItem, queda linkeado acá (null si el usuario
  // descartó el ítem por no ser comida o por error de lectura)
  pantryItemId: uuid("pantry_item_id").references(() => pantryItems.id, {
    onDelete: "set null",
  }),
});

// ---- pantryItems (el inventario real, vive y se edita en el tiempo) ----

export const pantryItems = pgTable("pantry_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  displayName: text("display_name").notNull(), // editable por el usuario en cualquier momento
  quantity: numeric("quantity", { precision: 10, scale: 3 }).notNull(),
  unit: unitEnum("unit").notNull(),
  category: foodCategoryEnum("category").notNull(),
  purchaseDate: timestamp("purchase_date", { withTimezone: true }),
  // Vencimiento estimado — se calcula en base a categoría al crear el ítem,
  // pero el usuario lo puede corregir a mano en cualquier momento.
  estimatedExpirationDate: timestamp("estimated_expiration_date", {
    withTimezone: true,
  }),
  // true si vino de un escaneo de ticket; false si el usuario lo cargó a mano
  // o lo agregó desde la lista de compras al volver del super.
  addedManually: boolean("added_manually").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---- pantryConsumptionEvents ----
// Historial inmutable de cada vez que se resta cantidad de un producto,
// con el motivo. pantryItemId puede quedar null si el producto se borró
// del todo (consumido/tirado por completo) — igual conservamos el evento
// para no perder el historial de desperdicio.

export const pantryConsumptionEvents = pgTable("pantry_consumption_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  pantryItemId: uuid("pantry_item_id").references(() => pantryItems.id, {
    onDelete: "set null",
  }),
  displayName: text("display_name").notNull(), // copia del nombre al momento del evento
  quantity: numeric("quantity", { precision: 10, scale: 3 }).notNull(),
  unit: unitEnum("unit").notNull(),
  category: foodCategoryEnum("category").notNull(),
  eventType: consumptionEventTypeEnum("event_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---- shoppingListItems ----
// Lo que el usuario quiere comprar. Cantidad y unidad son opcionales porque
// en una lista de compras muchas veces alcanza con "leche". Al volver del
// super, los ítems tildados se pasan a la alacena (ver shoppingListService).

export const shoppingListItems = pgTable("shopping_list_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  displayName: text("display_name").notNull(),
  quantity: numeric("quantity", { precision: 10, scale: 3 }),
  unit: unitEnum("unit"),
  category: foodCategoryEnum("category").notNull(),
  checked: boolean("checked").notNull().default(false),
  // true si vino de una sugerencia de la IA (para poder medir si sirven)
  suggestedByAi: boolean("suggested_by_ai").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---- Relaciones (para queries con .with en Drizzle) ----

export const receiptsRelations = relations(receipts, ({ many }) => ({
  items: many(receiptItems),
}));

export const receiptItemsRelations = relations(receiptItems, ({ one }) => ({
  receipt: one(receipts, {
    fields: [receiptItems.receiptId],
    references: [receipts.id],
  }),
  pantryItem: one(pantryItems, {
    fields: [receiptItems.pantryItemId],
    references: [pantryItems.id],
  }),
}));

export const pantryItemsRelations = relations(pantryItems, ({ many }) => ({
  sourceReceiptItems: many(receiptItems),
}));
