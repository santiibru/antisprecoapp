/**
 * App.tsx
 *
 * Primera pasada de diseño. Concepto: la app gira en torno al ticket de
 * compra, así que el ticket ES el lenguaje visual — separadores punteados
 * (el corte perforado de un recibo real) en vez de tarjetas con sombra,
 * números en fuente monoespaciada (como una caja registradora), y el color
 * de vencimiento como único sistema de alerta, sin insignias de más.
 *
 * Paleta: Lino Salvia (fondo), Tinta Botella (texto), Ámbar Maduro (acento/CTA),
 * Verde Hierba (fresco), Rojo Remolacha (vencido/urgente).
 * Tipografía: Fraunces (identidad — título, secciones) + Work Sans (funcional).
 */

import { useState, useEffect, useRef } from "react";

type ParsedItem = {
  raw_name: string;
  display_name: string;
  quantity: number | null; // lo que la IA leyó de ESTE ticket — editable si se equivocó
  unit: string | null;
  line_total: number | null;
  category: string;
  is_food: boolean;
  confidence: "low" | "medium" | "high";
  pantryItemId: string | null;
  finalQuantity: number | null; // total YA acumulado en la alacena (solo informativo acá)
  originalQuantity: number | null; // copia inmutable de "quantity" al llegar, para calcular el ajuste
};

type ReceiptResponse = {
  receiptId: string;
  checksumOk: boolean | null;
  itemsDetected: number;
  pantryItemsUpdated: number;
  items: ParsedItem[];
};

type PantryItem = {
  id: string;
  displayName: string;
  quantity: string;
  unit: string;
  category: string;
  estimatedExpirationDate: string | null;
};

type ShoppingItem = {
  id: string;
  displayName: string;
  quantity: string | null;
  unit: string | null;
  category: string;
  checked: boolean;
  suggestedByAi: boolean;
};

type ShoppingSuggestion = {
  displayName: string;
  category: string;
  quantity: number | null;
  unit: string | null;
  reason: string;
};

type RecipeSuggestion = {
  title: string;
  usesExpiringSoon: boolean;
  usedIngredients: string[];
  missingIngredients: string[];
  instructions: string[];
};

const API_URL = "http://localhost:3001";

const CONFIDENCE_LABEL: Record<ParsedItem["confidence"], string> = {
  high: "segura",
  medium: "revisar",
  low: "revisar",
};

// Mismas categorías que food_category en schema.ts — capa técnica en inglés,
// acá solo la traducción para mostrar en el selector.
const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "produce", label: "Frutas y verduras" },
  { value: "dairy", label: "Lácteos" },
  { value: "bakery", label: "Panadería" },
  { value: "meat_fish", label: "Carnes y pescado" },
  { value: "pantry", label: "Almacén" },
  { value: "beverages", label: "Bebidas" },
  { value: "snacks", label: "Snacks" },
  { value: "cleaning", label: "Limpieza" },
  { value: "personal_care", label: "Higiene personal" },
  { value: "other", label: "Otro" },
];

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORY_OPTIONS.map((opt) => [opt.value, opt.label])
);

// Agrupa por categoría y ordena alfabéticamente tanto los grupos como los
// productos dentro de cada grupo. "Otro" va siempre al final.
function groupByCategory<T extends { category: string; displayName: string }>(
  items: T[]
): { category: string; label: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(item.category) ?? [];
    list.push(item);
    groups.set(item.category, list);
  }
  return [...groups.entries()]
    .map(([category, list]) => ({
      category,
      label: CATEGORY_LABEL[category] ?? category,
      items: list.sort((a, b) =>
        a.displayName.localeCompare(b.displayName, "es", { sensitivity: "base" })
      ),
    }))
    .sort((a, b) => {
      if (a.category === "other") return 1;
      if (b.category === "other") return -1;
      return a.label.localeCompare(b.label, "es", { sensitivity: "base" });
    });
}

const EMPTY_SHOPPING_ITEM = {
  displayName: "",
  category: "pantry",
  quantity: "",
  unit: "unit",
};

const EMPTY_MANUAL_ITEM = {
  displayName: "",
  category: "pantry",
  quantity: "",
  unit: "unit",
  purchaseDate: "",
};

// Verde → ámbar → rojo según días para vencer. Es el único sistema de
// alerta de la app: nada de insignias ni iconografía extra.
function freshnessColor(dateStr: string | null): string {
  if (!dateStr) return COLORS.textFaint;
  const days = Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
  if (days < 0) return COLORS.danger;
  if (days <= 2) return COLORS.accent;
  return COLORS.fresh;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [result, setResult] = useState<ReceiptResponse | null>(null);
  const [editedItems, setEditedItems] = useState<ParsedItem[]>([]);
  const [pantry, setPantry] = useState<PantryItem[]>([]);
  const [pantryLoading, setPantryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [mergeBaseId, setMergeBaseId] = useState<string | null>(null);

  // Filtro por categoría de la alacena — null = todas.
  const [pantryFilter, setPantryFilter] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  const [consumeAmounts, setConsumeAmounts] = useState<Record<string, string>>({});
  const [consumingId, setConsumingId] = useState<string | null>(null);

  // Edición directa de un producto ya guardado en la alacena — para
  // corregir errores de carga (ej. lo agregaste por unidad y en realidad
  // se mide por peso), sin depender de que vuelva a aparecer en un escaneo.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ displayName: string; quantity: string; unit: string }>({
    displayName: "",
    quantity: "",
    unit: "unit",
  });
  const [savingEdit, setSavingEdit] = useState(false);

  // Alta manual — mismos campos que un producto que viene de un ticket
  // (nombre, categoría, cantidad, unidad), tal como están en pantry_items.
  const [manualItem, setManualItem] = useState(EMPTY_MANUAL_ITEM);
  const [addingManual, setAddingManual] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  // Vista simple con pestañas — todavía sin router, alcanza para esta etapa.
  const [activeView, setActiveView] = useState<"pantry" | "shopping" | "recipes">("pantry");
  const [recipes, setRecipes] = useState<RecipeSuggestion[] | null>(null);
  const [recipesLoading, setRecipesLoading] = useState(false);
  const [recipesError, setRecipesError] = useState<string | null>(null);

  // Lista de compras — se carga al abrir la pestaña. Las sugerencias de la
  // IA se piden a mano (cuestan una consulta) y quedan como propuestas hasta
  // que el usuario las agrega o las descarta.
  const [shoppingList, setShoppingList] = useState<ShoppingItem[]>([]);
  const [shoppingLoading, setShoppingLoading] = useState(false);
  const [shoppingError, setShoppingError] = useState<string | null>(null);
  const [newShoppingItem, setNewShoppingItem] = useState(EMPTY_SHOPPING_ITEM);
  const [addingShopping, setAddingShopping] = useState(false);
  const [movingToPantry, setMovingToPantry] = useState(false);
  const [suggestions, setSuggestions] = useState<ShoppingSuggestion[] | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  // Cargamos Fraunces + Work Sans una sola vez, sin tocar index.html.
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Work+Sans:wght@400;500;600&display=swap";
    document.head.appendChild(link);
    return () => {
      document.head.removeChild(link);
    };
  }, []);

  async function loadPantry() {
    setPantryLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/pantry`);
      const data = await res.json();
      setPantry(data);
    } finally {
      setPantryLoading(false);
    }
  }

  useEffect(() => {
    loadPantry();
  }, []);

  function handleFileSelect(selected: File | null) {
    setFile(selected);
    setResult(null);
    setSaved(false);
    setError(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(selected ? URL.createObjectURL(selected) : null);
  }

  async function handleUpload() {
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setSaved(false);

    try {
      const formData = new FormData();
      formData.append("image", file);

      const res = await fetch(`${API_URL}/api/receipts?lang=es`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Algo salió mal procesando el ticket");
      }

      const data: ReceiptResponse = await res.json();
      setResult(data);
      setEditedItems(data.items.map((item) => ({ ...item, originalQuantity: item.quantity })));
      await loadPantry();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function updateItem(
    index: number,
    field: "quantity" | "unit" | "display_name",
    value: string
  ) {
    setSaved(false);
    setEditedItems((prev) =>
      prev.map((item, i) =>
        i === index
          ? { ...item, [field]: field === "quantity" ? Number(value) : value }
          : item
      )
    );
  }

  async function handleSaveEdits() {
    setSaving(true);
    try {
      const withId = editedItems.filter((item) => item.pantryItemId);
      await Promise.all(
        withId.map((item) => {
          const original = item.originalQuantity ?? 1;
          const corrected = item.quantity ?? 1;
          const adjustment = corrected - original;
          const adjustedTotal = (item.finalQuantity ?? corrected) + adjustment;

          return fetch(`${API_URL}/api/pantry/${item.pantryItemId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              quantity: adjustedTotal,
              unit: item.unit || "unit",
              displayName: item.display_name,
            }),
          });
        })
      );
      setSaved(true);
      await loadPantry();
    } catch {
      setError("No se pudieron guardar los cambios, probá de nuevo");
    } finally {
      setSaving(false);
    }
  }

  function resetUpload() {
    handleFileSelect(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleMerge(targetId: string) {
    if (!mergeBaseId || mergeBaseId === targetId) return;
    setMerging(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/pantry/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: mergeBaseId, targetId }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "No se pudo fusionar");
      }
      setMergeBaseId(null);
      await loadPantry();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMerging(false);
    }
  }

  async function handleConsume(pantryItemId: string, eventType: "consumed" | "discarded") {
    const raw = consumeAmounts[pantryItemId];
    const amount = Number(raw);
    if (!raw || amount <= 0) return;

    setConsumingId(pantryItemId);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/pantry/${pantryItemId}/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity: amount, eventType }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "No se pudo registrar");
      }
      setConsumeAmounts((prev) => ({ ...prev, [pantryItemId]: "" }));
      await loadPantry();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConsumingId(null);
    }
  }

  function startEditing(item: PantryItem) {
    setEditingId(item.id);
    setEditDraft({ displayName: item.displayName, quantity: item.quantity, unit: item.unit });
    setError(null);
  }

  async function handleSaveEdit(id: string) {
    setSavingEdit(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/pantry/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: editDraft.displayName,
          quantity: Number(editDraft.quantity),
          unit: editDraft.unit,
        }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "No se pudo guardar el cambio");
      }
      setEditingId(null);
      await loadPantry();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleAddManualItem() {
    const quantity = Number(manualItem.quantity);
    if (!manualItem.displayName.trim()) {
      setManualError("Falta el nombre del producto");
      return;
    }
    if (!manualItem.quantity || quantity <= 0) {
      setManualError("La cantidad tiene que ser un número mayor a 0");
      return;
    }

    setAddingManual(true);
    setManualError(null);
    try {
      const res = await fetch(`${API_URL}/api/pantry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: manualItem.displayName.trim(),
          quantity,
          unit: manualItem.unit,
          category: manualItem.category,
          purchaseDate: manualItem.purchaseDate || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "No se pudo agregar el producto");
      }
      setManualItem(EMPTY_MANUAL_ITEM);
      await loadPantry();
    } catch (err) {
      setManualError((err as Error).message);
    } finally {
      setAddingManual(false);
    }
  }

  async function loadShoppingList() {
    setShoppingLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/shopping-list`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "No se pudo cargar la lista");
      }
      setShoppingList(await res.json());
    } catch (err) {
      setShoppingError((err as Error).message);
    } finally {
      setShoppingLoading(false);
    }
  }

  useEffect(() => {
    if (activeView === "shopping") loadShoppingList();
  }, [activeView]);

  async function postShoppingItem(item: {
    displayName: string;
    category: string;
    quantity: number | null;
    unit: string | null;
    suggestedByAi: boolean;
  }) {
    const res = await fetch(`${API_URL}/api/shopping-list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
    });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? "No se pudo agregar a la lista");
    }
  }

  async function handleAddShoppingItem() {
    if (!newShoppingItem.displayName.trim()) {
      setShoppingError("Falta el nombre del producto");
      return;
    }
    const quantity = newShoppingItem.quantity ? Number(newShoppingItem.quantity) : null;
    if (quantity !== null && quantity <= 0) {
      setShoppingError("La cantidad tiene que ser un número mayor a 0");
      return;
    }

    setAddingShopping(true);
    setShoppingError(null);
    try {
      await postShoppingItem({
        displayName: newShoppingItem.displayName.trim(),
        category: newShoppingItem.category,
        quantity,
        unit: quantity !== null ? newShoppingItem.unit : null,
        suggestedByAi: false,
      });
      setNewShoppingItem(EMPTY_SHOPPING_ITEM);
      await loadShoppingList();
    } catch (err) {
      setShoppingError((err as Error).message);
    } finally {
      setAddingShopping(false);
    }
  }

  async function handleAcceptSuggestion(suggestion: ShoppingSuggestion) {
    setShoppingError(null);
    try {
      await postShoppingItem({ ...suggestion, suggestedByAi: true });
      setSuggestions((prev) => prev?.filter((s) => s !== suggestion) ?? null);
      await loadShoppingList();
    } catch (err) {
      setShoppingError((err as Error).message);
    }
  }

  async function handleToggleShoppingItem(item: ShoppingItem) {
    // Actualización optimista: tildar tiene que sentirse instantáneo en el super.
    setShoppingList((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, checked: !i.checked } : i))
    );
    try {
      const res = await fetch(`${API_URL}/api/shopping-list/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checked: !item.checked }),
      });
      if (!res.ok) throw new Error("No se pudo actualizar el producto");
    } catch (err) {
      setShoppingError((err as Error).message);
      await loadShoppingList();
    }
  }

  async function handleDeleteShoppingItem(id: string) {
    setShoppingError(null);
    try {
      const res = await fetch(`${API_URL}/api/shopping-list/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("No se pudo quitar el producto");
      setShoppingList((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      setShoppingError((err as Error).message);
    }
  }

  async function handleMoveCheckedToPantry() {
    setMovingToPantry(true);
    setShoppingError(null);
    try {
      const res = await fetch(`${API_URL}/api/shopping-list/move-checked`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "No se pudo pasar a la alacena");
      }
      await Promise.all([loadShoppingList(), loadPantry()]);
    } catch (err) {
      setShoppingError((err as Error).message);
    } finally {
      setMovingToPantry(false);
    }
  }

  async function handleSuggestShopping() {
    setSuggestionsLoading(true);
    setShoppingError(null);
    try {
      const res = await fetch(`${API_URL}/api/shopping-list/suggestions?lang=es`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "No se pudieron generar sugerencias");
      }
      const data = await res.json();
      setSuggestions(data.suggestions);
    } catch (err) {
      setShoppingError((err as Error).message);
    } finally {
      setSuggestionsLoading(false);
    }
  }

  async function handleSuggestRecipes() {
    setRecipesLoading(true);
    setRecipesError(null);
    try {
      const res = await fetch(`${API_URL}/api/recipes?lang=es`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "No se pudieron generar recetas");
      }
      const data = await res.json();
      setRecipes(data.recipes);
    } catch (err) {
      setRecipesError((err as Error).message);
    } finally {
      setRecipesLoading(false);
    }
  }

  const pantryGroups = groupByCategory(pantry);
  // Si la categoría filtrada se quedó sin productos (se consumió o fusionó
  // todo), volvemos a mostrar todas en vez de una lista vacía.
  const activePantryFilter = pantryGroups.some((g) => g.category === pantryFilter)
    ? pantryFilter
    : null;

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.h1}>AntiSprecapp</h1>
        <p style={styles.subtitle}>La app que te ayuda a cocinar sin desperdiciar</p>
      </header>

      <nav style={styles.tabs}>
        <button
          onClick={() => setActiveView("pantry")}
          style={activeView === "pantry" ? styles.tabActive : styles.tab}
        >
          Alacena
        </button>
        <button
          onClick={() => setActiveView("shopping")}
          style={activeView === "shopping" ? styles.tabActive : styles.tab}
        >
          Lista de compras
        </button>
        <button
          onClick={() => setActiveView("recipes")}
          style={activeView === "recipes" ? styles.tabActive : styles.tab}
        >
          Recetas
        </button>
      </nav>

      {activeView === "pantry" && (
        <>
      <section style={styles.section}>
        <h2 style={styles.h2}>Escaneá un ticket</h2>

        {!previewUrl ? (
          <label style={styles.dropzone}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
              style={{ display: "none" }}
            />
            <span style={{ fontSize: "1.8rem" }}>+</span>
            <span>Tocá para subir un ticket de compra</span>
          </label>
        ) : (
          <div style={styles.previewRow}>
            <img src={previewUrl} alt="Ticket seleccionado" style={styles.previewImg} />
            <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              <button
                onClick={handleUpload}
                disabled={loading}
                style={{ ...styles.buttonPrimary, opacity: loading ? 0.6 : 1 }}
              >
                {loading ? "Escaneando…" : "Escanear este ticket"}
              </button>
              <button onClick={resetUpload} style={styles.buttonGhost}>
                Elegir otra foto
              </button>
            </div>
          </div>
        )}

        {error && <p style={styles.errorText}>{error}</p>}

        <h2 style={{ ...styles.h2, marginTop: "1.75rem" }}>O agregá los productos manualmente</h2>

        <div style={styles.manualForm}>
          <input
            type="text"
            placeholder="Nombre del producto"
            value={manualItem.displayName}
            onChange={(e) => setManualItem((prev) => ({ ...prev, displayName: e.target.value }))}
            style={{ ...styles.inputName, flex: "1 1 180px" }}
            disabled={addingManual}
          />
          <select
            value={manualItem.category}
            onChange={(e) => setManualItem((prev) => ({ ...prev, category: e.target.value }))}
            style={{ ...styles.inputSmall, width: "auto", flex: "1 1 140px" }}
            disabled={addingManual}
          >
            {CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <input
            type="number"
            placeholder="Cant."
            value={manualItem.quantity}
            onChange={(e) => setManualItem((prev) => ({ ...prev, quantity: e.target.value }))}
            style={{ ...styles.inputSmall, width: "72px" }}
            disabled={addingManual}
          />
          <select
            value={manualItem.unit}
            onChange={(e) => setManualItem((prev) => ({ ...prev, unit: e.target.value }))}
            style={styles.inputSmall}
            disabled={addingManual}
          >
            <option value="unit">unidad</option>
            <option value="g">g</option>
            <option value="kg">kg</option>
            <option value="ml">ml</option>
            <option value="l">l</option>
          </select>
          <input
            type="date"
            value={manualItem.purchaseDate}
            onChange={(e) => setManualItem((prev) => ({ ...prev, purchaseDate: e.target.value }))}
            style={{ ...styles.inputSmall, width: "auto" }}
            disabled={addingManual}
            title="Fecha de compra (opcional, por defecto hoy)"
          />
          <button
            onClick={handleAddManualItem}
            disabled={addingManual}
            style={{ ...styles.buttonPrimary, opacity: addingManual ? 0.6 : 1 }}
          >
            {addingManual ? "Agregando…" : "Agregar"}
          </button>
        </div>

        {manualError && <p style={styles.errorText}>{manualError}</p>}
      </section>

      {result && (
        <section style={styles.section}>
          <h2 style={styles.h2}>Revisá lo detectado</h2>
          <p style={styles.helperText}>
            {result.itemsDetected} productos encontrados.{" "}
            {result.checksumOk === false &&
              "Los precios no cierran del todo — revisá cantidades con más atención."}
            {result.checksumOk === true && "Los totales coinciden."}
          </p>

          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Producto</th>
                  <th style={styles.th}>Cant.</th>
                  <th style={styles.th}>Unidad</th>
                  <th style={styles.th}>Estado</th>
                </tr>
              </thead>
              <tbody>
                {editedItems.map((item, i) => (
                  <tr key={i}>
                    <td style={styles.td}>
                      <input
                        type="text"
                        value={item.display_name}
                        onChange={(e) => updateItem(i, "display_name", e.target.value)}
                        style={styles.inputName}
                        disabled={!item.pantryItemId}
                      />
                      {!item.is_food && <span style={styles.badgeMuted}> no es comida</span>}
                    </td>
                    <td style={styles.td}>
                      <input
                        type="number"
                        value={item.quantity ?? ""}
                        onChange={(e) => updateItem(i, "quantity", e.target.value)}
                        style={styles.inputSmall}
                        disabled={!item.pantryItemId}
                      />
                      {item.finalQuantity !== null && (
                        <div style={styles.miniHint}>
                          en alacena: {item.finalQuantity} {item.unit}
                        </div>
                      )}
                    </td>
                    <td style={styles.td}>
                      <select
                        value={item.unit ?? "unit"}
                        onChange={(e) => updateItem(i, "unit", e.target.value)}
                        style={styles.inputSmall}
                        disabled={!item.pantryItemId}
                      >
                        <option value="unit">unidad</option>
                        <option value="g">g</option>
                        <option value="kg">kg</option>
                        <option value="ml">ml</option>
                        <option value="l">l</option>
                      </select>
                    </td>
                    <td
                      style={{
                        ...styles.td,
                        color: item.confidence === "low" ? COLORS.accent : COLORS.textFaint,
                      }}
                    >
                      {CONFIDENCE_LABEL[item.confidence]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: "1.1rem", display: "flex", alignItems: "center", gap: "1rem" }}>
            <button
              onClick={handleSaveEdits}
              disabled={saving}
              style={{ ...styles.buttonPrimary, opacity: saving ? 0.6 : 1 }}
            >
              {saving ? "Guardando…" : "Guardar cambios"}
            </button>
            {saved && <span style={styles.savedText}>Guardado en tu alacena</span>}
          </div>
        </section>
      )}

      <section style={styles.section}>
        <h2 style={styles.h2}>Tu alacena{!pantryLoading && ` — ${pantry.length}`}</h2>

        {pantry.length > 1 && (
          <p style={styles.helperText}>
            {mergeBaseId
              ? "Elegí con cuál producto fusionarlo (o tocá el mismo de nuevo para cancelar)."
              : "¿Dos productos repetidos con nombre distinto? Tocá \"Fusionar\" en uno."}
          </p>
        )}

        {pantryGroups.length > 1 && (
          <div style={styles.filterRow}>
            <button
              onClick={() => setPantryFilter(null)}
              style={activePantryFilter === null ? styles.filterChipActive : styles.filterChip}
            >
              Todas <span style={styles.chipCount}>{pantry.length}</span>
            </button>
            {pantryGroups.map((group) => (
              <button
                key={group.category}
                onClick={() => setPantryFilter(group.category)}
                style={activePantryFilter === group.category ? styles.filterChipActive : styles.filterChip}
              >
                {group.label} <span style={styles.chipCount}>{group.items.length}</span>
              </button>
            ))}
          </div>
        )}

        {pantryLoading ? (
          <p style={styles.helperText}>Cargando…</p>
        ) : pantry.length === 0 ? (
          <p style={styles.helperText}>Todavía no hay nada acá — escaneá un ticket para empezar.</p>
        ) : (
          pantryGroups
            .filter((group) => activePantryFilter === null || group.category === activePantryFilter)
            .map((group) => (
          <div key={group.category} style={styles.categoryGroup}>
          <h3 style={styles.categoryHeading}>
            {group.label} <span style={styles.categoryCount}>{group.items.length}</span>
          </h3>
          <ul style={styles.pantryList}>
            {group.items.map((item) => {
              const isBase = mergeBaseId === item.id;
              const isConsuming = consumingId === item.id;
              const isEditing = editingId === item.id;

              if (isEditing) {
                return (
                  <li key={item.id} style={styles.pantryRow}>
                    <div style={styles.pantryActions}>
                      <input
                        type="text"
                        value={editDraft.displayName}
                        onChange={(e) =>
                          setEditDraft((prev) => ({ ...prev, displayName: e.target.value }))
                        }
                        style={{ ...styles.inputName, flex: 1 }}
                        disabled={savingEdit}
                      />
                    </div>
                    <div style={styles.pantryActions}>
                      <input
                        type="number"
                        value={editDraft.quantity}
                        onChange={(e) =>
                          setEditDraft((prev) => ({ ...prev, quantity: e.target.value }))
                        }
                        style={styles.inputSmall}
                        disabled={savingEdit}
                      />
                      <select
                        value={editDraft.unit}
                        onChange={(e) => setEditDraft((prev) => ({ ...prev, unit: e.target.value }))}
                        style={styles.inputSmall}
                        disabled={savingEdit}
                      >
                        <option value="unit">unidad</option>
                        <option value="g">g</option>
                        <option value="kg">kg</option>
                        <option value="ml">ml</option>
                        <option value="l">l</option>
                      </select>
                      <button
                        onClick={() => handleSaveEdit(item.id)}
                        disabled={savingEdit}
                        style={{ ...styles.buttonGhostSmall, color: COLORS.fresh, borderColor: COLORS.fresh }}
                      >
                        {savingEdit ? "Guardando…" : "Guardar"}
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        disabled={savingEdit}
                        style={styles.buttonGhostSmall}
                      >
                        Cancelar
                      </button>
                    </div>
                  </li>
                );
              }

              return (
                <li key={item.id} style={styles.pantryRow}>
                  <div style={styles.pantryTopRow}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: "0.55rem" }}>
                      <span
                        style={{
                          ...styles.freshnessDot,
                          background: freshnessColor(item.estimatedExpirationDate),
                        }}
                      />
                      <span style={isBase ? { ...styles.pantryName, color: COLORS.accent } : styles.pantryName}>
                        {item.displayName}
                      </span>
                      <span style={styles.pantryMeta}>
                        {Number(item.quantity)} {item.unit}
                        {item.estimatedExpirationDate &&
                          ` · vence ${item.estimatedExpirationDate.split("T")[0]}`}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: "0.4rem" }}>
                      <button
                        onClick={() => startEditing(item)}
                        style={styles.buttonGhostSmall}
                      >
                        Editar
                      </button>
                      <button
                        disabled={merging}
                        onClick={() =>
                          mergeBaseId
                            ? isBase
                              ? setMergeBaseId(null)
                              : handleMerge(item.id)
                            : setMergeBaseId(item.id)
                        }
                        style={styles.buttonGhostSmall}
                      >
                        {isBase ? "Cancelar" : mergeBaseId ? "Fusionar con este" : "Fusionar"}
                      </button>
                    </div>
                  </div>
                  <div style={styles.pantryActions}>
                    <input
                      type="number"
                      placeholder="cant."
                      value={consumeAmounts[item.id] ?? ""}
                      onChange={(e) =>
                        setConsumeAmounts((prev) => ({ ...prev, [item.id]: e.target.value }))
                      }
                      style={{ ...styles.inputSmall, width: "56px" }}
                      disabled={isConsuming}
                    />
                    <button
                      onClick={() => handleConsume(item.id, "consumed")}
                      disabled={isConsuming}
                      style={{ ...styles.buttonGhostSmall, color: COLORS.fresh, borderColor: COLORS.fresh }}
                    >
                      Consumí
                    </button>
                    <button
                      onClick={() => handleConsume(item.id, "discarded")}
                      disabled={isConsuming}
                      style={{ ...styles.buttonGhostSmall, color: COLORS.danger, borderColor: COLORS.danger }}
                    >
                      Tiré
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          </div>
          ))
        )}
      </section>
        </>
      )}

      {activeView === "shopping" && (
        <>
          <section style={styles.section}>
            <h2 style={styles.h2}>Sugerencias para reponer</h2>
            <p style={styles.helperText}>
              En base a lo que consumís seguido y ya se terminó en tu alacena.
            </p>

            <button
              onClick={handleSuggestShopping}
              disabled={suggestionsLoading}
              style={{ ...styles.buttonPrimary, opacity: suggestionsLoading ? 0.6 : 1 }}
            >
              {suggestionsLoading ? "Pensando…" : suggestions ? "Sugerir de nuevo" : "Sugerir productos"}
            </button>

            {suggestions && suggestions.length === 0 && (
              <p style={styles.helperText}>
                Todavía no hay suficiente historial — a medida que marques "Consumí" en la
                alacena, las sugerencias van a ir apareciendo.
              </p>
            )}

            {suggestions && suggestions.length > 0 && (
              <ul style={{ ...styles.pantryList, marginTop: "0.9rem" }}>
                {suggestions.map((s, i) => (
                  <li key={i} style={styles.suggestionRow}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                      <span style={styles.pantryName}>
                        {s.displayName}
                        {s.quantity !== null && s.unit && (
                          <span style={styles.pantryMeta}>
                            {" "}
                            · {s.quantity} {s.unit}
                          </span>
                        )}
                      </span>
                      <span style={styles.miniHint}>{s.reason}</span>
                    </div>
                    <div style={{ display: "flex", gap: "1rem" }}>
                      <button
                        onClick={() => handleAcceptSuggestion(s)}
                        style={{ ...styles.buttonGhostSmall, color: COLORS.fresh, borderColor: COLORS.fresh }}
                      >
                        Agregar
                      </button>
                      <button
                        onClick={() => setSuggestions((prev) => prev?.filter((x) => x !== s) ?? null)}
                        style={styles.buttonGhostSmall}
                      >
                        Descartar
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={styles.section}>
            <h2 style={styles.h2}>Agregar a la lista</h2>
            <div style={styles.manualForm}>
              <input
                type="text"
                placeholder="Nombre del producto"
                value={newShoppingItem.displayName}
                onChange={(e) =>
                  setNewShoppingItem((prev) => ({ ...prev, displayName: e.target.value }))
                }
                onKeyDown={(e) => e.key === "Enter" && handleAddShoppingItem()}
                style={{ ...styles.inputName, flex: "1 1 180px" }}
                disabled={addingShopping}
              />
              <select
                value={newShoppingItem.category}
                onChange={(e) => setNewShoppingItem((prev) => ({ ...prev, category: e.target.value }))}
                style={{ ...styles.inputSmall, width: "auto", flex: "1 1 140px" }}
                disabled={addingShopping}
              >
                {CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                placeholder="Cant."
                value={newShoppingItem.quantity}
                onChange={(e) => setNewShoppingItem((prev) => ({ ...prev, quantity: e.target.value }))}
                style={{ ...styles.inputSmall, width: "72px" }}
                disabled={addingShopping}
                title="Cantidad (opcional)"
              />
              <select
                value={newShoppingItem.unit}
                onChange={(e) => setNewShoppingItem((prev) => ({ ...prev, unit: e.target.value }))}
                style={styles.inputSmall}
                disabled={addingShopping}
              >
                <option value="unit">unidad</option>
                <option value="g">g</option>
                <option value="kg">kg</option>
                <option value="ml">ml</option>
                <option value="l">l</option>
              </select>
              <button
                onClick={handleAddShoppingItem}
                disabled={addingShopping}
                style={{ ...styles.buttonPrimary, opacity: addingShopping ? 0.6 : 1 }}
              >
                {addingShopping ? "Agregando…" : "Agregar"}
              </button>
            </div>

            {shoppingError && <p style={styles.errorText}>{shoppingError}</p>}
          </section>

          <section style={styles.section}>
            <h2 style={styles.h2}>
              Tu lista{!shoppingLoading && ` — ${shoppingList.length}`}
            </h2>

            {shoppingLoading && shoppingList.length === 0 ? (
              <p style={styles.helperText}>Cargando…</p>
            ) : shoppingList.length === 0 ? (
              <p style={styles.helperText}>
                La lista está vacía — agregá algo arriba o pedile sugerencias a la IA.
              </p>
            ) : (
              <>
                {groupByCategory(shoppingList).map((group) => (
                  <div key={group.category} style={styles.categoryGroup}>
                    <h3 style={styles.categoryHeading}>
                      {group.label} <span style={styles.categoryCount}>{group.items.length}</span>
                    </h3>
                    <ul style={styles.pantryList}>
                      {group.items.map((item) => (
                        <li key={item.id} style={styles.shoppingRow}>
                          <label style={styles.shoppingLabel}>
                            <input
                              type="checkbox"
                              checked={item.checked}
                              onChange={() => handleToggleShoppingItem(item)}
                              style={{ accentColor: COLORS.fresh }}
                            />
                            <span
                              style={
                                item.checked
                                  ? { ...styles.pantryName, textDecoration: "line-through", color: COLORS.textFaint }
                                  : styles.pantryName
                              }
                            >
                              {item.displayName}
                            </span>
                            {item.quantity && (
                              <span style={styles.pantryMeta}>
                                {Number(item.quantity)} {item.unit}
                              </span>
                            )}
                            {item.suggestedByAi && <span style={styles.badgeMuted}>sugerido</span>}
                          </label>
                          <button
                            onClick={() => handleDeleteShoppingItem(item.id)}
                            style={styles.buttonGhostSmall}
                          >
                            Quitar
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}

                {shoppingList.some((i) => i.checked) && (
                  <div style={{ marginTop: "1.1rem" }}>
                    <button
                      onClick={handleMoveCheckedToPantry}
                      disabled={movingToPantry}
                      style={{ ...styles.buttonPrimary, opacity: movingToPantry ? 0.6 : 1 }}
                    >
                      {movingToPantry ? "Pasando…" : "Pasar lo comprado a la alacena"}
                    </button>
                    <p style={styles.miniHint}>
                      Lo que no tenga cantidad entra como 1 unidad — lo podés corregir desde la alacena.
                    </p>
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}

      {activeView === "recipes" && (
        <section style={styles.section}>
          <h2 style={styles.h2}>Recetas con lo que tenés</h2>
          <p style={styles.helperText}>
            Prioriza lo que está por vencer, para que no se eche a perder.
          </p>

          <button
            onClick={handleSuggestRecipes}
            disabled={recipesLoading}
            style={{ ...styles.buttonPrimary, opacity: recipesLoading ? 0.6 : 1 }}
          >
            {recipesLoading ? "Pensando…" : recipes ? "Sugerir de nuevo" : "Sugerir recetas"}
          </button>

          {recipesError && <p style={styles.errorText}>{recipesError}</p>}

          {recipes && recipes.length === 0 && (
            <p style={styles.helperText}>
              No hay suficientes productos en la alacena para sugerir algo todavía.
            </p>
          )}

          {recipes && recipes.length > 0 && (
            <ul style={styles.recipeList}>
              {recipes.map((recipe, i) => (
                <li key={i} style={styles.recipeCard}>
                  <div style={styles.recipeTitleRow}>
                    <h3 style={styles.recipeTitle}>{recipe.title}</h3>
                    {recipe.usesExpiringSoon && (
                      <span style={styles.expiringBadge}>usa lo que vence pronto</span>
                    )}
                  </div>
                  <p style={styles.recipeIngredients}>
                    <strong>Usa de tu alacena:</strong> {recipe.usedIngredients.join(", ")}
                  </p>
                  {recipe.missingIngredients.length > 0 && (
                    <p style={styles.recipeIngredients}>
                      <strong>Te falta:</strong> {recipe.missingIngredients.join(", ")}
                    </p>
                  )}
                  <ol style={styles.recipeSteps}>
                    {recipe.instructions.map((step, j) => (
                      <li key={j}>{step}</li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

// ---- Design tokens ----
// Concepto: el ticket de compra es el lenguaje visual — separadores
// punteados en vez de tarjetas con sombra, monoespaciada para números
// (como una caja registradora), color de vencimiento como único semáforo.
const COLORS = {
  bg: "#F2F4ED", // Lino Salvia
  surface: "#FBFAF6", // Papel Crema (para inputs, ligeramente más claro que el fondo)
  ink: "#1B3328", // Tinta Botella
  textFaint: "#6B7A70",
  accent: "#E2A33D", // Ámbar Maduro
  fresh: "#4C7A57", // Verde Hierba
  danger: "#A23E3E", // Rojo Remolacha
  rule: "#C9D0C1", // línea punteada tipo perforación de ticket
};

const FONT_DISPLAY = "'Fraunces', Georgia, serif";
const FONT_BODY = "'Work Sans', system-ui, sans-serif";
const FONT_MONO = "'Courier New', monospace"; // números — evoca la caja registradora

const styles: Record<string, React.CSSProperties> = {
  page: {
    fontFamily: FONT_BODY,
    maxWidth: "560px",
    margin: "0 auto",
    padding: "1.75rem 1.25rem 3rem",
    color: COLORS.ink,
    background: COLORS.bg,
    minHeight: "100vh",
  },
  header: { marginBottom: "1.75rem" },
  h1: {
    fontFamily: FONT_DISPLAY,
    fontSize: "2rem",
    fontWeight: 600,
    margin: 0,
    letterSpacing: "-0.01em",
  },
  subtitle: { color: COLORS.textFaint, fontSize: "0.92rem", marginTop: "0.3rem" },
  section: {
    borderTop: `1px dashed ${COLORS.rule}`,
    paddingTop: "1.5rem",
    marginTop: "1.5rem",
  },
  h2: {
    fontFamily: FONT_DISPLAY,
    fontSize: "1.15rem",
    fontWeight: 500,
    marginTop: 0,
    marginBottom: "0.85rem",
  },
  dropzone: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.5rem",
    padding: "2rem",
    border: `1.5px dashed ${COLORS.rule}`,
    borderRadius: "10px",
    cursor: "pointer",
    color: COLORS.textFaint,
    background: COLORS.surface,
  },
  manualForm: { display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" },
  previewRow: { display: "flex", gap: "1rem", alignItems: "flex-start" },
  previewImg: {
    width: "110px",
    borderRadius: "6px",
    border: `1px solid ${COLORS.rule}`,
    objectFit: "cover",
  },
  buttonPrimary: {
    background: COLORS.accent,
    color: COLORS.ink,
    border: "none",
    borderRadius: "999px",
    padding: "0.65rem 1.3rem",
    cursor: "pointer",
    fontSize: "0.92rem",
    fontWeight: 600,
    fontFamily: FONT_BODY,
  },
  buttonGhost: {
    background: "transparent",
    color: COLORS.ink,
    border: `1px solid ${COLORS.rule}`,
    borderRadius: "999px",
    padding: "0.6rem 1.2rem",
    cursor: "pointer",
    fontSize: "0.9rem",
    fontFamily: FONT_BODY,
  },
  buttonGhostSmall: {
    background: "transparent",
    border: "1px solid " + COLORS.rule,
    borderRadius: "999px",
    padding: "0.3rem 0.65rem",
    cursor: "pointer",
    fontSize: "0.78rem",
    fontFamily: FONT_BODY,
    whiteSpace: "nowrap",
    color: COLORS.ink,
  },
  errorText: { color: COLORS.danger, marginTop: "0.75rem", fontSize: "0.9rem" },
  helperText: { color: COLORS.textFaint, fontSize: "0.88rem" },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.88rem" },
  th: {
    textAlign: "left",
    borderBottom: `1px dashed ${COLORS.rule}`,
    padding: "0.4rem 0.3rem",
    color: COLORS.textFaint,
    fontWeight: 500,
    fontSize: "0.78rem",
  },
  td: {
    padding: "0.5rem 0.3rem",
    borderBottom: `1px dashed ${COLORS.rule}`,
    fontFamily: FONT_MONO,
    fontSize: "0.85rem",
  },
  inputSmall: {
    width: "58px",
    padding: "0.3rem",
    border: `1px solid ${COLORS.rule}`,
    borderRadius: "5px",
    fontFamily: FONT_MONO,
    background: COLORS.surface,
    color: COLORS.ink,
  },
  inputName: {
    width: "100%",
    minWidth: "140px",
    padding: "0.3rem",
    border: `1px solid ${COLORS.rule}`,
    borderRadius: "5px",
    fontFamily: FONT_BODY,
    background: COLORS.surface,
    color: COLORS.ink,
  },
  miniHint: { color: COLORS.textFaint, fontSize: "0.68rem", marginTop: "0.2rem", fontFamily: FONT_BODY },
  badgeMuted: { color: COLORS.textFaint, fontSize: "0.7rem", marginLeft: "0.4rem", fontFamily: FONT_BODY },
  savedText: { color: COLORS.fresh, fontSize: "0.88rem" },
  pantryList: { listStyle: "none", margin: 0, padding: 0 },
  pantryRow: {
    padding: "0.7rem 0",
    borderBottom: `1px dashed ${COLORS.rule}`,
    display: "flex",
    flexDirection: "column",
    gap: "0.45rem",
  },
  pantryTopRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "0.4rem" },
  pantryName: { fontSize: "0.95rem" },
  freshnessDot: { width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0 },
  pantryMeta: { color: COLORS.textFaint, fontSize: "0.8rem", fontFamily: FONT_MONO },
  pantryActions: { display: "flex", gap: "0.4rem", alignItems: "center" },
  categoryGroup: { marginTop: "1.1rem" },
  filterRow: { display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.9rem" },
  filterChip: {
    background: "transparent",
    border: `1px solid ${COLORS.rule}`,
    borderRadius: "999px",
    padding: "0.3rem 0.75rem",
    cursor: "pointer",
    fontSize: "0.8rem",
    fontFamily: FONT_BODY,
    color: COLORS.ink,
    whiteSpace: "nowrap",
  },
  filterChipActive: {
    background: COLORS.ink,
    border: `1px solid ${COLORS.ink}`,
    borderRadius: "999px",
    padding: "0.3rem 0.75rem",
    cursor: "pointer",
    fontSize: "0.8rem",
    fontFamily: FONT_BODY,
    color: COLORS.surface,
    whiteSpace: "nowrap",
  },
  chipCount: { fontFamily: FONT_MONO, fontSize: "0.72rem", opacity: 0.7, marginLeft: "0.15rem" },
  categoryHeading: {
    fontFamily: FONT_DISPLAY,
    fontSize: "0.95rem",
    fontWeight: 600,
    margin: "0 0 0.2rem",
    color: COLORS.fresh,
  },
  categoryCount: { color: COLORS.textFaint, fontFamily: FONT_MONO, fontSize: "0.78rem", fontWeight: 400 },
  suggestionRow: {
    padding: "0.6rem 0",
    borderBottom: `1px dashed ${COLORS.rule}`,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "0.5rem",
  },
  shoppingRow: {
    padding: "0.55rem 0",
    borderBottom: `1px dashed ${COLORS.rule}`,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "0.5rem",
  },
  shoppingLabel: { display: "flex", alignItems: "baseline", gap: "0.55rem", cursor: "pointer", flexWrap: "wrap" },
  tabs: { display: "flex", gap: "0.5rem", marginBottom: "0.5rem" },
  tab: {
    background: "transparent",
    border: "none",
    borderBottom: "2px solid transparent",
    padding: "0.5rem 0.2rem",
    cursor: "pointer",
    fontSize: "0.95rem",
    fontFamily: FONT_DISPLAY,
    color: COLORS.textFaint,
  },
  tabActive: {
    background: "transparent",
    border: "none",
    borderBottom: `2px solid ${COLORS.accent}`,
    padding: "0.5rem 0.2rem",
    cursor: "pointer",
    fontSize: "0.95rem",
    fontFamily: FONT_DISPLAY,
    color: COLORS.ink,
    fontWeight: 600,
  },
  recipeList: { listStyle: "none", margin: "1.1rem 0 0", padding: 0, display: "flex", flexDirection: "column", gap: "1.1rem" },
  recipeCard: { paddingBottom: "1.1rem", borderBottom: `1px dashed ${COLORS.rule}` },
  recipeTitleRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "0.4rem" },
  recipeTitle: { fontFamily: FONT_DISPLAY, fontSize: "1.05rem", fontWeight: 500, margin: 0 },
  expiringBadge: { fontSize: "0.7rem", color: COLORS.accent, fontFamily: FONT_BODY },
  recipeIngredients: { fontSize: "0.85rem", color: COLORS.textFaint, margin: "0.4rem 0" },
  recipeSteps: { fontSize: "0.88rem", paddingLeft: "1.2rem", margin: "0.5rem 0 0", display: "flex", flexDirection: "column", gap: "0.3rem" },
};
