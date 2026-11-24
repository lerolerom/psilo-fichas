import type { FilaComparacion } from "./motor.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const ESTILO = `
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;color:#1a1a1a;background:#fafafa}
header{padding:16px 20px;background:#fff;border-bottom:1px solid #e5e5e5;position:sticky;top:0}
h1{font-size:18px;margin:0}.sub{color:#666;font-size:13px;margin-top:4px}
main{padding:16px 20px;display:grid;gap:12px}
.fila{background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:12px}
.cab{font-size:13px;color:#555;margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap}
.chip{background:#f0f0f0;border-radius:999px;padding:2px 8px}
.cols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
@media(max-width:800px){.cols{grid-template-columns:1fr}}
.col h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#888;margin:0 0 6px}
.burbuja{background:#f5f5f5;border-radius:8px;padding:8px;margin-bottom:6px;white-space:pre-wrap;font-size:14px}
.agente .burbuja{background:#e8f3ec}.real .burbuja{background:#eef1f8}
.accion{font-size:13px;color:#7a4b00;background:#fff6e5;border-radius:8px;padding:6px 8px;margin-top:4px}
.vacio{color:#aaa;font-size:13px}`;

export function htmlComparacion(fecha: string, filas: FilaComparacion[]): string {
  const cuerpo = filas.length
    ? filas
        .map(
          (f) => `<section class="fila">
  <div class="cab"><strong>+${esc(f.telefono)}</strong>${f.nombre ? `<span>${esc(f.nombre)}</span>` : ""}<span class="chip">${esc(f.modo)}</span>${f.etapa ? `<span class="chip">etapa: ${esc(f.etapa)}</span>` : ""}${f.minutosReal != null ? `<span class="chip">real: ${f.minutosReal} min</span>` : ""}${f.minutosAgente != null ? `<span class="chip">agente: ~${f.minutosAgente} min</span>` : ""}</div>
  <div class="cols">
    <div class="col"><h3>Lead</h3>${f.lead.map((t) => `<div class="burbuja">${esc(t)}</div>`).join("") || '<div class="vacio">(seguimiento: el lead no escribió)</div>'}</div>
    <div class="col agente"><h3>Habría enviado el agente</h3>${f.propuesta.map((t) => `<div class="burbuja">${esc(t)}</div>`).join("") || '<div class="vacio">(nada)</div>'}${f.accion ? `<div class="accion">${esc(f.accion)}</div>` : ""}</div>
    <div class="col real"><h3>Se envió de verdad</h3>${f.real.map((r) => `<div class="burbuja">${esc(r.texto)}</div>`).join("") || '<div class="vacio">(todavía nada)</div>'}</div>
  </div>
</section>`,
        )
        .join("\n")
    : '<p class="vacio">Sin propuestas este día.</p>';
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Modo sombra ${esc(fecha)}</title><style>${ESTILO}</style></head>
<body><header><h1>Modo sombra: ${esc(fecha)}</h1><div class="sub">${filas.length} momentos. El agente no envió nada: esto es lo que habría hecho, frente a lo que se envió de verdad.</div></header><main>${cuerpo}</main></body></html>`;
}

export function htmlListaChrome(fecha: string, filas: { telefono: string; propuesta: string; motivo: string; estado: string; nombre: string | null }[]): string {
  const cuerpo = filas.length
    ? filas
        .map(
          (f, i) => `<section class="fila" data-telefono="+${esc(f.telefono)}">
  <div class="cab"><strong>${i + 1}. +${esc(f.telefono)}</strong>${f.nombre ? `<span>${esc(f.nombre)}</span>` : ""}<span class="chip">${esc(f.motivo)}</span><span class="chip">${esc(f.estado)}</span></div>
  <div class="burbuja">${esc(f.propuesta)}</div>
</section>`,
        )
        .join("\n")
    : '<p class="vacio">No hay seguimientos para hoy.</p>';
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Seguimientos ${esc(fecha)}</title><style>${ESTILO}</style></head>
<body><header><h1>Seguimientos para las rondas: ${esc(fecha)}</h1><div class="sub">Antes de enviar: verifica nombre y número en el encabezado, lee el chat y, si el lead ya escribió o alguien del equipo ya contestó, no envíes. Envía el texto tal cual.</div></header><main>${cuerpo}</main></body></html>`;
}
