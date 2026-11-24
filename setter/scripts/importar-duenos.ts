/**
 * Importa los dueños de chat (las etiquetas MARIO / DANI / VERO de la app) antes de encender el agente.
 * Las etiquetas de la app WhatsApp Business no llegan por la API, así que hay que cargarlas una vez.
 *
 * Uso: npm run importar-duenos -- duenos.csv
 * CSV con encabezado: telefono,dueno,etapa,nombre
 *   0991234567,MARIO,Qualified,Ana Pérez
 *   593987654321,VERO,,
 *
 * No borra ni pisa conversaciones: solo crea el lead o actualiza dueño/etapa/nombre.
 */
import fs from "node:fs";
import { config, normalizarTelefono } from "../src/config.js";
import { ETAPAS, Store, type Dueno, type Etapa } from "../src/db.js";

const archivo = process.argv[2];
if (!archivo) {
  console.error("Uso: npm run importar-duenos -- archivo.csv");
  process.exit(1);
}

const store = new Store(config.DB_PATH);
const lineas = fs.readFileSync(archivo, "utf8").split(/\r?\n/).filter((l) => l.trim());
const [enc, ...filas] = lineas;
const cols = enc.split(",").map((c) => c.trim().toLowerCase());
let creados = 0;
let actualizados = 0;
const errores: string[] = [];

for (const fila of filas) {
  const v = fila.split(",").map((c) => c.trim());
  const get = (k: string) => v[cols.indexOf(k)] ?? "";
  const tel = normalizarTelefono(get("telefono"));
  const dueno = get("dueno").toUpperCase() as Dueno;
  if (!tel || !["MARIO", "DANI", "VERO"].includes(dueno)) {
    errores.push(fila);
    continue;
  }
  const etapa = ETAPAS.find((e) => e.toLowerCase() === get("etapa").toLowerCase()) as Etapa | undefined;
  const nombre = get("nombre") || null;
  const previo = store.lead(tel);
  if (!previo) {
    store.crearLead(tel, { dueno, nombre, origen: "importado" });
    creados++;
  } else {
    actualizados++;
  }
  store.actualizar(tel, { dueno, ...(etapa ? { etapa } : {}), ...(nombre ? { nombre } : {}) });
}

console.log(`Creados: ${creados}. Actualizados: ${actualizados}. Filas con error: ${errores.length}`);
for (const e of errores) console.log("  ", e);
