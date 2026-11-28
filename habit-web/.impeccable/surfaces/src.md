---
version: 1
slug: "src"
primary_target: "src"
related_targets: []
---

# Mundo visual de The Dager Habit: Ficha de préstamo

## Alcance y modo

Modo **Operate**. Cubre las tres pantallas (Hoy, Biblioteca, Ajustes) y los flujos de Leer, Volcado y Repaso. Se construye code-led, en celular primero (390 px), con una mano. Redesign completo: el look anterior (papel crema, verde bosque, Fraunces, DM Sans) se reemplaza. El nombre se mantiene.

## Audiencia, tarea y restricciones

Una persona que acaba de leer, con poca energía, que quiere registrar la sesión en segundos y saber qué repasa hoy. Acción principal única por pantalla. Voseo rioplatense. Objetivos de 44 px o más, WCAG 2.2 AA, movimiento reducido respetado. El juego no usa culpa: la planta que muere es un reinicio registrado, nunca un reproche. Prohibido el sello VOID, el rojo de alerta y los avisos de pérdida.

## Direction contract

THESIS: Cada repaso es una fecha de vencimiento sellada. La pantalla es la ficha pegada en la contratapa de un libro de biblioteca, no un panel de rachas con tarjetas; cada logro es un sello, nunca un contador ni una barra.

OWN-WORLD: Verde buckram #1F5F54 como campo del shell (fondo, barra de pestañas), cartulina manila #E3C48C para las fichas, blanco hueso #FBF6E6 para campos, tinta marrón #2A2118 para texto y trazos, violeta de sello #5B2D8E solo para sellos, fechas cumplidas y la flor. Courier Prime solo en fechas, sellos y rótulos; Archivo en acciones y cuerpo. Sellos con giro de 2 a 4° y tinta despareja, botón principal con doble filete; sin degradés, vidrio ni sombras difusas.

STORY: La persona entiende qué toca hoy en un vistazo, toca una vez y ve su fecha sellada. Cree que cuesta segundos y que repasar hace crecer la planta. Si la planta muere, queda una vida registrada y una ficha nueva.

FIRST VIEWPORT: En 390×844, una barra verde con el wordmark «The Dager Habit» y «Pausar». Debajo, una ficha manila de unos 600 px: título «Fecha de vencimiento» sobre una regla, la planta dibujada a línea fina (150 px), cuatro filas de repaso (+2, +3, +5, +7 días) con sello SELLADO o PENDIENTE, y al pie el botón principal verde «Repasar «Dune»» de 64 px, en la zona del pulgar. Barra de tres pestañas (Hoy, Biblioteca, Ajustes) de 76 px.

FORM: Ficha de préstamo, posición 1 de mi lista ordenada (la ruleta asignó la 3; elegida por el usuario como IMPECCABLE'S PICK), seed:f12f444b60cbe38c. Firma: el sello, una pulsación de 180 ms que se apoya sobre la fecha; con movimiento reducido aparece ya estampado.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Arte de la planta (SVG paramétrico, a línea)

Una función `plant({ stage, wilt, dead, life })` dibuja todo con el mismo esqueleto, trazo marrón de 2,5 px y la flor en violeta.
- **stage** 0 a 4: semilla, brote, joven, adulta, floración (1, 3, 7, 14 y 30 días cumplidos; supuesto reversible). Crece altura, cantidad y tamaño de hojas.
- **wilt** 0 a 4: cada nivel inclina el tallo y curva las hojas más, y pasa la tinta de marrón a sepia #8A6A3B; en 4 queda un tallo doblado con una hoja. Un solo nivel de diferencia tiene que verse en cada día.
- **dead**: el quinto día seguido, la planta se acuesta en trazo punteado, sepia, como flor prensada, con rótulo «Vida N · X días». Se archiva como ficha; no hay rojo ni «VOID».
- **life**: semilla nueva = óvalo con un brote mínimo y un sello circular violeta «Vida 2» (la marca de resiliencia). Las fichas anteriores quedan apiladas y visibles.
- Todas las etapas llevan texto accesible («Planta joven, nivel 2 de marchitado») y no dependen del color.

## Sin decidir

Cómo se apila el historial de vidas en Ajustes. Qué hace la pausa con la ficha (propuesta: la ficha se ve cerrada con un clip).
