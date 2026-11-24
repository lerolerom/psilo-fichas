# Setter de Despertar: agente sobre WhatsApp Business

Agente que atiende leads por WhatsApp siguiendo el **Manual del Setter v2 + adenda v2.2**, desde el primer contacto hasta que el lead paga la evaluación de $40. Usa la **WhatsApp Cloud API en coexistencia**: el mismo número sigue funcionando en la app WhatsApp Business del equipo, y el agente se calla cuando alguien del equipo escribe desde la app.

## Cómo funciona

```
Lead escribe ──> Webhook de Meta ──> /webhook ──> SQLite (lead + mensajes)
                                                     │
          ¿riesgo? ── sí ──> contención fija (171 op. 6 / 911) + alerta URGENTE a fundadores, chat en pausa
                                                     │ no
          espera 90 s a que termine de escribir (debounce)
                                                     │
                       Claude (manual del setter + herramientas)
                                                     │
      ┌──────────────────────┬───────────────────────┴───────────────┐
  rutina: envía           escala a Mario: NO envía,             caliente: envía
  (máx. 2 mensajes)       pausa el chat y le manda              y además avisa
                          la propuesta lista
```

**Modo híbrido (por defecto).** El agente responde solo en lo rutinario: Engage, Connect, Psicoeducar, ofrecer la evaluación, primer precio, objeciones del manual. Escala a Mario con una propuesta lista para enviar en los casos que el manual reserva: riesgo, medicación, preguntas clínicas, beca, fuera de Quito, familiar puente, "¿es legal?", menores, adicción, precio completo, audios/imágenes, y cuando el lead elige día y hora (Mario manda el link de pago).

**Reglas que se cumplen en código (no dependen del modelo):**
- Riesgo: detección por palabras clave antes del agente. Riesgo explícito → mensaje de contención fijo con 171 opción 6 y 911, alerta urgente y pausa. Señal ambigua ("huir", "desaparecer") → no se responde nada automático y se alerta.
- Chats de Vero: no se contestan ni se marcan como leídos. Única excepción: una señal de riesgo se avisa a los fundadores, sin escribirle al lead.
- Si alguien del equipo escribe desde la app, el agente calla 12 h en ese chat.
- Chats que el equipo abre desde la app y que el sistema no conoce: quedan en pausa hasta que se les asigne dueño.
- Máximo dos mensajes seguidos. Sin raya larga. Nunca se baja una etapa. Nunca se borran ni se pisan leads.
- Horario de envío 08:00 a 21:00 (Quito). Los seguimientos solo en día hábil (sin fines de semana ni feriados).
- Cadencia del manual v2: Contactado mismo día, 2, 4, 8 días; Abrió/Conectado/Educado 1 día y luego cada 3; Ofrecido 1, 3 y luego cada 5; tras 4 intentos, mensual. Si el lead contesta, se reinicia.
- Dentro de las 24 h desde el último mensaje del lead, el seguimiento lo redacta el agente; fuera de esa ventana, solo plantillas aprobadas (ver [PLANTILLAS.md](PLANTILLAS.md)), rotando para no repetir.
- 14 días sin respuesta: Intake → Not qualified. 21 días: Qualified → Lost (solo si hubo más de un mensaje nuestro).
- "Agendó sesión Evaluación" y "Converted" solo los marca Mario (comandos `PAGADO` y `CONVERTIDO`).

## Comandos de Mario por WhatsApp

Desde un número listado en `ADMIN_NUMEROS`, escribiendo al número de Despertar:

| Comando | Qué hace |
|---|---|
| `OK 12` | Envía la propuesta de la escalación #12 y reanuda el chat |
| `EDITAR 12 <texto>` | Envía tu texto en lugar de la propuesta (párrafos separados por línea en blanco = 2 mensajes) |
| `IGNORAR 12` | Cierra la escalación sin enviar nada (si era riesgo, el chat sigue en pausa) |
| `PENDIENTES` | Lista escalaciones abiertas |
| `ESTADO 0991234567` | Dueño, etapa, paso, pausa y próximo toque |
| `PAUSA 0991234567` / `REANUDAR 0991234567` | Apaga o enciende el agente en un chat |
| `DUEÑO 0991234567 VERO` | Asigna dueño (MARIO, DANI, VERO) |
| `ETAPA 0991234567 Qualified` | Corrige la etapa a mano |
| `PAGADO 0991234567 2026-11-27 15:00` | Marca Agendó y, si hay calendario conectado, crea la evaluación con recordatorios el día anterior y 2 h antes |
| `CONVERTIDO 0991234567` | Marca Converted |

## Puesta en marcha

### 1. Meta: número en coexistencia
1. En Meta for Developers crea una app tipo **Business** y agrega el producto **WhatsApp**.
2. Conecta el número actual con el flujo de **coexistencia** (incorporación de usuarios de la app WhatsApp Business, desde Embedded Signup o desde un proveedor de soluciones). Así el número sigue en la app del equipo y además queda en la Cloud API. Acepta la sincronización del historial si te la ofrece.
3. Crea un **usuario del sistema** en el Business Manager con permisos `whatsapp_business_messaging` y `whatsapp_business_management`, y genera un **token permanente** (`WA_ACCESS_TOKEN`). Anota el **Phone Number ID** (`WA_PHONE_NUMBER_ID`) y la **clave secreta de la app** (`WA_APP_SECRET`).
4. Crea y envía a aprobación las plantillas de [PLANTILLAS.md](PLANTILLAS.md), después de que Mario las revise.

### 2. Despliegue (Railway, Render o Fly.io)
1. Despliega la carpeta `setter/` con el `Dockerfile`. **Monta un volumen persistente en `/data`**: ahí vive la base SQLite.
2. Carga las variables de `.env.example`. Empieza con `MODO=aprobacion` los primeros días si quieres revisar todo antes de pasar a `hibrido`.
3. Verifica que `https://TU-DOMINIO/salud` responda.

### 3. Webhook
En la app de Meta > WhatsApp > Configuración: URL `https://TU-DOMINIO/webhook`, token de verificación = `WA_VERIFY_TOKEN`. Suscribe los campos **`messages`** y **`smb_message_echoes`** (los mensajes que el equipo envía desde la app). Para formularios instantáneos, suscribe la página al campo **`leadgen`** y carga `META_PAGE_ACCESS_TOKEN`.

### 4. Antes de encender: importar dueños
Las etiquetas MARIO/DANI/VERO de la app **no llegan por la API**. Exporta la lista de chats con su etiqueta y cárgala una vez:
```bash
npm run importar-duenos -- duenos.csv   # columnas: telefono,dueno,etapa,nombre
```
Cualquier número desconocido que escriba se asigna a `DUENO_POR_DEFECTO` (MARIO). **Si no importas los chats de Vero, el agente les contestaría.**

### 5. Leads de formulario, landing o Make/Zapier
```bash
curl -X POST https://TU-DOMINIO/api/leads \
  -H "Authorization: Bearer $ADMIN_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"telefono":"0991234567","nombre":"Ana","formulario":"Ansiedad desde hace años","origen":"formulario"}'
```
`origen`: `formulario` | `instagram` | `abandonado` (los abandonados quedan en pausa hasta que Mario decida). Exporta el estado con `GET /api/leads.csv` para cruzarlo con el Leads Center de Meta.

## Probar sin WhatsApp

```bash
npm install
npm test                                   # 39 pruebas de reglas (sin red)
ANTHROPIC_API_KEY=... npm run simular -- --nombre Ana --formulario "Tengo ansiedad hace años"
```
El simulador usa Claude de verdad: escribes como lead y ves lo que mandaría el agente, la etapa y las escalaciones. Línea vacía = avanza el reloj un día (para ver seguimientos). `/OK 1` = comando de Mario.

## Modelo y costos
`claude-opus-5-5` con esfuerzo `medium`, manual en caché (prompt caching) y respaldo automático de modelo si el principal se niega a responder. Para bajar costos puedes probar `CLAUDE_MODEL=claude-sonnet-5-5` contra el simulador antes de cambiarlo en producción.

## Pendientes de definir con Mario (el sistema ya los trata con cautela)
- Cómo presentarse en chats de Dani (`PRESENTACION_DANI`). Mientras esté vacío, el primer mensaje se escala.
- Link de pago y quién confirma el pago. Hoy: el agente reserva, escala con categoría `pago`, y Mario confirma con `PAGADO`.
- Si se escribe a leads abandonados. Hoy: se escala con la propuesta del manual.
- Máximo de mensajes por hora y por día (`MAX_MENSAJES_HORA`, por defecto 60).
- Regla de dueño en Instagram: este sistema solo cubre WhatsApp.
- Regla para menciones de adicción: hoy se escala.
- Video educativo (`VIDEO_EDUCATIVO_URL`) y testimonios aprobados.

## Verificar en la primera semana
- Desde aquí no se pudo leer la documentación de Meta. Revisa en los registros que el primer eco de la app llegue como `smb_message_echoes` con `message_echoes[].to`; si llega con otra forma, ajusta `parsearWebhook` en `src/whatsapp.ts`.
- La versión de Graph (`WA_GRAPH_VERSION=v23.0`): usa la que muestre tu panel de Meta.
- La lista de palabras de riesgo (`src/riesgo.ts`): revisa con Dani si falta alguna expresión local.

## Estructura
```
src/server.ts            arranque + ciclo cada 20 s
src/app.ts               rutas HTTP (webhook, API interna)
src/motor.ts             orquestador: entrantes, ecos, turnos, seguimiento, escalación, comandos
src/agent/manual.ts      el Manual del Setter como instrucciones del agente  <- aquí se editan las reglas
src/agent/agente.ts      ciclo con Claude y herramientas
src/agent/herramientas.ts
src/riesgo.ts            detección determinista de riesgo
src/tiempo.ts            horarios, días hábiles, cadencia de seguimiento
src/whatsapp.ts          Cloud API, firma del webhook, parseo
src/calendario.ts        Google Calendar (opcional)
src/db.ts                SQLite
```
