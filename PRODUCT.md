# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Monolito decidido por el usuario: ASP.NET Core (.NET 10) sirve la web y la API, SQLite como base de datos, Angular 22 como frontend. La app móvil es la misma PWA instalable; más adelante, un envoltorio nativo (Capacitor) para las tiendas.

## Users

Una persona que quiere retener lo que lee y corre la app en su propio servidor (self-hosted), sola o con su círculo. Abre la app justo después de leer, muchas veces desde el celular, con poca energía y pocas ganas de cargar datos. Alguien que publique su instancia en internet es un caso posible, no el principal.

## Product Purpose

Hacer que leer deje huella: la persona lee, cuenta lo que recuerda y la app le pide repetirlo en fechas espaciadas (2, 3, 5 y 7 días). Éxito: el hábito se sostiene porque registrar cada sesión cuesta segundos, no minutos.

## Positioning

Un hábito de lectura con recuperación activa cuyo costo de carga tiende a cero (voz, un toque, recordatorios) y que corre en el servidor de la propia persona, sin cuentas ajenas ni claves obligatorias.

## Operating Context

- Self-hosted: cada persona despliega su instancia (Docker). Los datos viven en un archivo SQLite en su servidor.
- Web Push y la instalación como PWA requieren HTTPS (localhost queda exento). La documentación nombra servicios genéricos: un servidor web (proxy inverso), una VPN y un certificado que el navegador acepte. Un certificado autofirmado no está verificado para push en celulares (ver «Sin decidir»).
- El login arranca deshabilitado. Se activa desde Ajustes: usuario local con contraseña y, opcional, segundo factor TOTP (Bitwarden, Google Authenticator), sin correo.
- Voseo rioplatense en toda la interfaz.

## Capabilities and Constraints

Confirmado para la v1:
- Cuentas locales opcionales (desactivadas por defecto), 2FA TOTP opcional, sin correo.
- Biblioteca, sesión de lectura y repasos espaciados.
- Captura por voz del volcado de memoria con el dictado del teclado del celular, sin API de reconocimiento propia.
- Recordatorios push desde la PWA.
- Metadatos de libros en cascada: Open Library, Google Books (clave opcional) y Hardcover (token opcional), más escaneo de ISBN con la cámara. Si ninguna fuente responde, la persona carga título y autor y la app completa los datos en segundo plano. Las fuentes se modelan como una interfaz para que cada instancia pueda sumar otra por su cuenta; no se incluye ninguna biblioteca clandestina.
- Gamificación con una sola planta personal, apagable desde Ajustes. Se marchita de forma progresiva durante 4 días sin actividad, con el deterioro visible cada día, y muere el quinto. Si la persona retoma el hábito, planta una semilla nueva y la app conserva un registro visible de esa recuperación como marca de resiliencia. Mientras la planta se marchita, 3 días seguidos de hábito recuperado la devuelven al estado óptimo. Un día cuenta como cumplido si la persona hace un repaso o un volcado. Los días sin repasos pendientes tienen una regla propia para no castigar sin motivo. Hay una pausa manual por viaje o enfermedad que congela la planta.
- Sección de configuración.

Se descarta: NotebookLM y la pantalla Resúmenes, la matriz de ocho proveedores de IA con su cupo global y el token manual de la API.

Fuera de la v1 y a repensar: IA como ayuda opcional (v2), horario inteligente que aprende cuándo lee la persona (v2; los eventos de lectura se registran desde el primer día), envoltorio nativo.

Sin decidir: fuentes de metadatos y su orden (Open Library no cubre todo el catálogo; candidatos Google Books, Hardcover, escaneo de ISBN), cómo se ve la marca de resiliencia, si un certificado autofirmado permite push en celulares (hay que probarlo en un dispositivo real), recuperación de contraseña sin correo, migración de los datos actuales de IndexedDB, zona horaria por persona en lugar de Buenos Aires fijo.

## Brand Commitments

El nombre se mantiene: The Dager Habit. El resto de la identidad visual se reemplaza por completo (rebranding); el sistema visual anterior (papel crema, verde bosque, Fraunces) es evidencia, no autoridad.

## Evidence on Hand

Código actual en `habit-web` y `habit-api`, README y `habit-web/DESIGN.md`. No hay testimonios, métricas ni usuarios reales documentados; no se inventan.

## Product Principles

1. Registrar una sesión tiene que costar segundos: voz y un toque antes que formularios.
2. Funciona sin claves ni cuentas ajenas; lo opcional queda apagado por defecto.
3. Una acción principal por pantalla. Lo que no se entiende a la primera se quita.
4. Los datos son de la persona: viven en su servidor y se pueden exportar.
5. La automatización suma, nunca decide en silencio: todo aviso, toda lectura de hábitos y toda mecánica de juego se pueden ver y apagar.
6. El juego premia lo que genera retención (repasar y volcar lo recordado), nunca solo abrir la app. Si la planta muere, es un reinicio que queda registrado como resiliencia, nunca un reproche ni un aviso culposo.

## Accessibility & Inclusion

WCAG 2.2 AA como piso. Uso táctil con una mano, objetivos de 44 px o más, foco visible, movimiento reducido respetado, interfaz en español rioplatense.
