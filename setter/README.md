# Setter de Despertar: agente sobre WhatsApp Business

Agente que atiende leads por WhatsApp siguiendo el **Manual del Setter para IA (Claude) Despertar** y las reglas activas de **Correcciones y aprendizajes del Setter** (al 24 nov 2026), desde el primer contacto hasta que el lead paga la evaluación de $40. Usa la **WhatsApp Cloud API en coexistencia**: el número sigue funcionando en la app WhatsApp Business del celular de Mario. Reemplaza las rondas de Claude in Chrome sobre WhatsApp Web: no hay navegador, pestañas ni rondas; cada mensaje llega al instante por webhook.

## Cómo se comporta (decisiones de Mario, 24 nov 2026)

- **Como una persona, no como un sistema.** No contesta al instante: espera un tiempo de "lectura" al azar (3 a 10 minutos, más si el mensaje es largo), marca el mensaje como leído, muestra "escribiendo..." el tiempo que tomaría escribir la respuesta y, si son dos mensajes, deja una pausa entre ellos. Contesta las 24 horas.
- **Nunca dice que es IA.** El código bloquea antes del envío cualquier mensaje con "IA", "asistente", "bot", "automático" o "Claude". Si un lead pregunta si habla con una persona o con un bot, no se le responde: el caso pasa a Mario.
- **Audios.** Se transcriben con Whisper en el mismo servidor (gratis; el audio no sale del servidor) y el agente los responde como a un texto. La detección de riesgo también corre sobre la transcripción.
- **Mario escribe desde la app.** El agente ve esos mensajes dentro de la conversación y sigue desde el siguiente mensaje del lead, con el tono y el rumbo de Mario. Si el lead contesta enseguida a Mario, el agente espera 10 minutos por si Mario sigue.
- **Seguimientos.** Uno por día hábil, siempre con algo nuevo; cada 3 días si el lead lleva más de una semana callado. Solo de lunes a viernes, alternando mañana (09:00 a 12:00) y tarde (15:00 a 18:30) a una hora al azar. Siguen en Lost y Not qualified hasta un "no" explícito; fechas acordadas ("escríbeme en enero") se respetan. Reconexiones tipo 3, 2 y 1 en los días 10, 12 y 18.
- **Agenda y pago.** El lead elige día y hora; el sistema revisa el calendario principal de Mario. Si está libre, envía la cuenta con el texto aprobado y el formulario. Si choca, le ofrece horarios libres cercanos. Con el comprobante (el agente ve la foto o el PDF) crea "Sesión de evaluación con [nombre]" de 45 minutos, con **link de Google Meet** si es en línea, se lo envía al lead, le pide el formulario, envía la dirección solo si es presencial y le avisa a Mario con el link. El día anterior a la cita recuerda y confirma asistencia (y el pago si falta).
- **Avisos a Mario.** Un solo reporte diario a las 07:50 con los casos que le tocan (con propuesta lista), las evaluaciones de hoy y mañana y los números de ayer (incluida la espera de los leads). Aviso inmediato solo por riesgo, reclamo, lead caliente, error de identidad y evaluación agendada.
- **Riesgo.** Ante "no quiero vivir", "ganas de morir", etc., el lead recibe de inmediato un mensaje fijo de contención con el 171 opción 6 y el 911, el chat se pausa y Mario recibe una alerta urgente. Nunca se vende.

### Revisión de cada mensaje antes de enviarlo
Lo que la auditora del sistema anterior encontraba después, aquí se bloquea antes (`src/agent/revision.ts`): palabras de identidad; "Gracias por contármelo / compartirlo / abrirte"; raya larga; emojis; viñetas; "guía"; voseo; más de una pregunta por mensaje; $790, $540, "lunes a jueves", "individual" o "grupal"; repetir los $40 junto con el $490; datos bancarios escritos a mano; links de agendamiento; la plantilla de primer mensaje en un chat con conversación; una cuarta pregunta de profundizar. El agente recibe el motivo y reescribe.

## Comandos de Mario por WhatsApp

| Comando | Qué hace |
|---|---|
| `OK 12` | Envía la propuesta de la escalación #12 y reanuda el chat |
| `EDITAR 12 <texto>` | Envía tu texto (párrafos separados por línea en blanco = 2 mensajes) |
| `IGNORAR 12` | Cierra la escalación sin enviar (si era riesgo, el chat sigue en pausa) |
| `PENDIENTES` / `REPORTE` | Casos abiertos / el reporte diario en ese momento |
| `ESTADO 0991234567` | Dueño, etapa, paso, cita y próximo toque |
| `PAUSA` / `REANUDAR 0991234567` | Apaga o enciende el agente en un chat |
| `DUEÑO 0991234567 VERO` | Asigna dueño (MARIO, DANI, VERO) |
| `ETAPA 0991234567 Qualified` | Corrige la etapa |
| `PAGADO 0991234567 2026-11-27 15:00 presencial` | Registra el pago a mano: agenda, confirma y envía lo que corresponde |
| `CONVERTIDO 0991234567` | Marca Converted |

## Puesta en marcha

1. **Meta.** App tipo Business con el producto WhatsApp; conectar el número actual por **coexistencia** (incorporación de usuarios de la app WhatsApp Business) y aceptar la sincronización del historial. Usuario del sistema con token permanente. Webhook `https://TU-DOMINIO/webhook` con los campos `messages`, `smb_message_echoes` y `history`. Aprobar las plantillas de [PLANTILLAS.md](PLANTILLAS.md).
2. **Google Calendar de Mario.** En Google Cloud Console habilitar Calendar API y crear un cliente OAuth tipo escritorio; en una computadora con navegador correr `GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run autorizar-google`, entrar con la cuenta de Mario y copiar el `GOOGLE_REFRESH_TOKEN`.
3. **Variables.** Copiar `.env.example` a `.env` y completar (cuenta para la transferencia, dirección, teléfono de Daniela, claves).
4. **Desplegar** con `docker compose up -d` (levanta el setter y Whisper). El volumen `datos` guarda la base; el volumen `modelos`, el modelo de Whisper.
5. **Importar los dueños y etapas** desde la hoja "CRM Leads WhatsApp Despertar" exportada a CSV: `npm run importar-duenos -- crm.csv`. Las etiquetas de la app no llegan por la API. Los chats importados quedan marcados como "con historial": nunca reciben la plantilla de primer mensaje.
6. **Apagar las rondas de Chrome** el mismo día que se enciende este sistema, para no contestar dos veces.

## Probar sin WhatsApp

```bash
npm install
npm test                                   # 47 pruebas, incluidos casos reales de la bitácora
ANTHROPIC_API_KEY=... npm run simular -- --nombre Ana --formulario "Tengo ansiedad hace años"
```

## Transcripción de las evaluaciones (Fireflies)
No requiere código: en Fireflies se conecta el Google Calendar de Mario y se activa que el asistente entre solo a las reuniones de Meet. Antes de grabar hay que pedir consentimiento expreso (la Ley Orgánica de Protección de Datos Personales de Ecuador trata los datos de salud como sensibles): en el formulario previo y al iniciar la sesión. Revisar en Fireflies los límites del plan gratuito.

## Pendientes de definir con Mario
- Presentación en chats de Dani (`PRESENTACION_DANI`).
- Texto de consentimiento para grabar la evaluación.
- Aprendizaje semanal a partir de lo que Mario escribe desde la app y de las transcripciones (propuestas de cambio al manual que Mario aprueba).
- Instagram, TikTok y Leads Center de Meta: fuera de este sistema por ahora (`GET /api/leads.csv` para cruzar).

## Verificar en la primera semana
- Desde este entorno no se pudo leer la documentación de Meta: confirmar en los registros la forma de los webhooks `smb_message_echoes` y `history`, y del indicador "escribiendo..." (`typing_indicator`). Si difieren, el ajuste está en `src/whatsapp.ts`.
- La etiqueta vigente de la imagen de Whisper en `docker-compose.yml`.
