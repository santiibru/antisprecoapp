/**
 * db.ts
 *
 * Conexión única a Postgres (Neon) usando Drizzle. Se importa este mismo
 * objeto `db` en cualquier parte del backend que necesite hacer queries —
 * no crear una conexión nueva por archivo.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as dotenv from "dotenv";
import * as schema from "./schema";

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error("Falta DATABASE_URL en el archivo .env");
}

const client = postgres(process.env.DATABASE_URL, { prepare: false });

export const db = drizzle(client, { schema });
