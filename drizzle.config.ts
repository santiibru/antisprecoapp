import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error(
    "Falta DATABASE_URL en el archivo .env — copiá el connection string de Neon ahí."
  );
}

export default defineConfig({
  schema: "./schema.ts",
  out: "./drizzle", // acá van a quedar guardadas las migraciones generadas
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  verbose: true,
  strict: true,
});
