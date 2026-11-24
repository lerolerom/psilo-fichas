# Plantillas para aprobar en Meta

Fuera de las 24 horas desde el último mensaje del lead, WhatsApp solo permite enviar plantillas aprobadas. El agente redacta libremente dentro de esa ventana; fuera de ella usa estas.

Créalas en **WhatsApp Manager > Plantillas de mensajes**, idioma **Español (es)**, con el nombre exacto. Son borradores que siguen el Manual del Setter: **Mario debe revisarlas antes de enviarlas a aprobación.**

| Nombre | Categoría | Texto |
|---|---|---|
| `alerta_setter` | Utilidad | Alerta del setter de Despertar: {{1}} |
| `primer_contacto_formulario` | Marketing | Hola {{1}}, te saluda {{2}} de Despertar. Leí lo que escribiste: "{{3}}". Mi función aquí es acompañarte a descubrir si esta terapia es para ti. ¿Hace cuánto lo sientes así? |
| `primer_contacto_sin_respuesta` | Marketing | Hola {{1}}, te saluda {{2}} de Despertar. Mi función aquí es acompañarte a descubrir si esta terapia es para ti. El formulario me llegó sin tu respuesta. Cuéntame qué te hizo escribirnos. |
| `seguimiento_contactado_1` | Marketing | {{1}}, si pudieras cambiar una sola cosa de cómo te sientes hoy, ¿cuál sería? |
| `seguimiento_contactado_2` | Marketing | {{1}}, muchas personas nos escriben cuando algo se repite y no saben cómo romperlo. ¿Qué es lo que más te está pesando a ti? |
| `seguimiento_conversando_1` | Marketing | {{1}}, me quedé pensando en lo que me contaste. ¿Qué cambiaría en tu día a día si eso dejara de pesarte? |
| `seguimiento_conversando_2` | Marketing | {{1}}, ¿qué has intentado hasta ahora para enfrentar lo que me contaste, y qué no te ha funcionado? |
| `seguimiento_ofrecido_1` | Marketing | {{1}}, la evaluación también puede ser en línea, sin moverte de casa. ¿Qué te ayudaría a tener más claridad para decidir? |
| `seguimiento_ofrecido_2` | Marketing | {{1}}, la evaluación sirve justamente para saber si eres candidato a la terapia, sin compromiso con el programa. ¿Qué duda te queda? |

Notas:
- `{{1}}` es el primer nombre del lead. En `primer_contacto_*`, `{{2}}` es la presentación del dueño del chat (por ejemplo "Mario") y `{{3}}` un resumen de lo que escribió en el formulario.
- En `seguimiento_ofrecido_2`, "candidato" está en masculino. Si Mario prefiere una versión neutra, por ejemplo "si esta terapia es para ti", cámbiala antes de aprobarla.
- Puedes agregar más variantes por paso y listarlas separadas por coma en `PLANTILLA_SEGUIMIENTO_*`: se rotan en cada toque para no repetir mensajes.
- Para que las alertas lleguen siempre, Mario puede escribirle "hola" al número de Despertar una vez al día desde su WhatsApp personal (abre la ventana de 24 h); si no, las alertas salen por la plantilla `alerta_setter`.
