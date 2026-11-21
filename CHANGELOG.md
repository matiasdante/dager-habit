# Historial de cambios

## [0.2.0] - 2026-11-21

### Biblioteca y estudio

- Buscá por título, autor o capítulo en tu colección, incluso sin conexión. El buscador admite palabras incompletas y tildes opcionales, y muestra los libros abiertos recientemente.
- Elegí una edición de Open Library por idioma, año o cantidad de páginas. Podés pegar un ISBN con espacios o guiones y abrir la ficha si la edición ya está guardada.
- Guardá la última página leída o marcá un capítulo como leído desde la colección. Podés editar la ficha y archivar libros conservando sus notas y sesiones.
- Consultá en **Hoy** los repasos pendientes y los próximos siete días. Las respuestas en curso se guardan al cambiar de pregunta o recargar.
- Pausá el temporizador y retomá con el tiempo que quedaba, incluso después de recargar.

### Respaldos

- Restaurá respaldos de más de 10 MB. Antes de confirmar, podés ver cuántos libros, sesiones y repasos trae el archivo y descargar una copia de tus datos actuales.

### Interfaz y calidad

- Transiciones en la biblioteca y el estudio que respetan la preferencia de movimiento reducido. La navegación conserva el foco y evita repetir las transiciones al volver con el historial.
- Precarga de las fuentes para el texto en español y reserva del espacio de la barra de desplazamiento para estabilizar la carga.
- Pruebas automatizadas en Chromium para el estudio offline, la restauración, el uso simultáneo en dos pestañas y las fallas del catálogo y la evaluación con IA.

## [0.1.0] - 2026-11-21

Primera versión de The Dager Habit.

- Biblioteca con búsqueda en Open Library, carga manual, secciones y progreso de lectura por libro.
- Sesiones guiadas de 10 o 15 minutos con preguntas previas, temporizador, volcado de memoria y examen.
- Repasos espaciados, racha de estudio y recordatorios exportables al calendario.
- App web instalable con datos locales y respaldo importable y exportable.
- Evaluaciones opcionales con IA, descarga de resúmenes y sincronización opcional con NotebookLM Enterprise.
- Arranque con Docker Compose, CI en GitHub Actions y licencia MIT.

[0.2.0]: https://github.com/matiasdante/dager-habit/releases/tag/v0.2.0
[0.1.0]: https://github.com/matiasdante/dager-habit/releases/tag/v0.1.0
