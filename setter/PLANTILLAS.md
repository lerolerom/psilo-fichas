# Plantillas para aprobar en Meta

Fuera de las 24 horas desde el último mensaje del lead, WhatsApp solo permite enviar plantillas aprobadas. Dentro de esa ventana el agente redacta a la medida; fuera de ella usa estas. Créalas en **WhatsApp Manager > Plantillas de mensajes**, idioma **Español (es)**, con el nombre exacto.

Los textos salen del Manual del Setter para IA (secciones 5 y 7). Mario debe revisarlos antes de enviarlos a aprobación.

| Nombre | Categoría | Texto |
|---|---|---|
| `alerta_setter` | Utilidad | Alerta del setter de Despertar: {{1}} |
| `primer_contacto_formulario` | Marketing | Hola {{1}}, gracias por escribirnos a Despertar. Te saluda {{2}}. Leí lo que escribiste: "{{3}}". Mi función aquí es acompañarte a descubrir si esta terapia es para ti. ¿Hace cuánto lo sientes así? |
| `primer_contacto_sin_respuesta` | Marketing | Hola {{1}}, gracias por escribirnos a Despertar. Te saluda {{2}}. Mi función aquí es acompañarte a descubrir si esta terapia es para ti. El formulario me llegó sin tu respuesta. Cuéntame qué te hizo escribirnos. |
| `primer_contacto_abandonado` | Marketing | Hola {{1}}, te saluda {{2}} de Despertar. Dejaste tus datos y quise escribirte. ¿Qué te hizo buscarnos? |
| `recordatorio_evaluacion` | Utilidad | Hola {{1}}, te recuerdo que {{2}} es tu evaluación a las {{3}}. ¿Me confirmas que sí vas a asistir? Si aún no hiciste la transferencia, envíame por favor el comprobante. |
| `reconexion_1` | Marketing | {{1}}, ¿te gustaría saber cómo puede ayudar a tu caso específico la terapia asistida con psilocibina? |
| `reconexion_2` | Marketing | {{1}}, me quedé pensando en lo que me contaste. ¿Eso sigue ahí hoy? |
| `reconexion_3` | Marketing | {{1}}, ¿sigues con ganas de cambiar eso que te trajo al formulario? Si ya no es el momento, dímelo y no te escribo más. |
| `seguimiento_contactado_1` | Marketing | {{1}}, si pudieras cambiar una sola cosa de cómo te sientes hoy, ¿cuál sería? |
| `seguimiento_contactado_2` | Marketing | {{1}}, la evaluación también puede ser en línea, sin moverte de casa. ¿Qué es lo que hoy más te pesa en tu día a día? |
| `seguimiento_conversando_1` | Marketing | {{1}}, me quedé pensando en lo que me contaste. ¿Cómo se siente eso en tu día a día? |
| `seguimiento_conversando_2` | Marketing | {{1}}, ¿qué crees que te ha impedido soltarlo hasta ahora? |
| `seguimiento_ofrecido_1` | Marketing | {{1}}, la evaluación también puede ser en línea, desde donde estés. ¿Qué te ayudaría a tener más claridad para decidir? |
| `seguimiento_ofrecido_2` | Marketing | {{1}}, te comparto historias de personas que hicieron el proceso acompañadas: https://youtube.com/playlist?list=PLi-B534urCtaEamepwTBLf7-zsGvprNho Ellos ya transformaron su vida, ahora te toca a ti. |

Notas:
- `{{1}}` es el primer nombre del lead; en los primeros contactos, `{{2}}` es la presentación del dueño del chat ("Mario") y `{{3}}` un resumen de lo que escribió en el formulario. En `recordatorio_evaluacion`, `{{2}}` es "mañana" u "hoy" y `{{3}}` la hora.
- Las reconexiones se usan una sola vez por lead: tipo 3 desde el día 10 sin respuesta (nunca contestó), tipo 2 desde el día 12 (contó su dolor y se calló), tipo 1 desde el día 18 (ya recibió horario o precio).
- Para que las alertas a Mario salgan como texto normal, basta que Mario le haya escrito al número de Despertar en las últimas 24 horas; si no, salen por `alerta_setter`.
