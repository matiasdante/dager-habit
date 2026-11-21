# Contribuir a The Dager Habit

Buscá primero si el problema o la idea ya tiene una [incidencia](https://github.com/matiasdante/dager-habit/issues). En un reporte de error incluí los pasos, lo que esperabas y lo que ocurrió. Usá datos de ejemplo y quitá claves, tokens y datos personales de capturas y registros.

## Preparar el entorno

1. Hacé un fork, clonalo y creá una rama como `fix/avance-de-lectura` desde `main`.
2. Con Node.js 26, ejecutá `npm ci` y `npm start` en `habit-web`. La web abre en [http://localhost:4200](http://localhost:4200).
3. Con el SDK de .NET 10, ejecutá `dotnet run --no-launch-profile --urls http://127.0.0.1:5080` en `habit-api`. Angular redirige las llamadas a la API a ese puerto. Las integraciones opcionales tienen su [configuración propia](habit-api/README.md).

## Verificar y abrir un PR

1. En `habit-web`, ejecutá `npm test` y `npm run build`. Desde la raíz, `docker compose up --build --wait` compila ambos componentes y levanta el contenedor.
2. Si cambiaste un flujo de la interfaz, corré las pruebas de navegador. Desde la raíz, ejecutá `dotnet build habit-api`. En `habit-web`, después de `npm ci` y `npm run build`, ejecutá `npx playwright install chromium` y `npm run test:browser`. Las pruebas levantan la API en un puerto local libre y simulan Open Library y la IA.
3. Abrí un PR hacia `main` con un cambio acotado. Contá qué problema resuelve, cómo lo verificaste y enlazá la incidencia si corresponde. Para cambios visuales, adjuntá una captura.

Usá mensajes de commit como `fix: corrijo el cálculo del avance` y actualizá la documentación cuando cambie la forma de usar la app.

## Criterios para flujos críticos

- Estudio y guardado. Una sesión y una respuesta de repaso en curso sobreviven a una recarga. La PWA puede completar ambos flujos offline después de la primera carga.
- Repasos. Un examen aparece en la fecha de Buenos Aires esperada. Dos pestañas no pueden registrar dos veces la misma respuesta pendiente.
- Respaldo. Un respaldo exportado se puede restaurar en otro perfil. Un archivo inválido deja los datos intactos. Si cambiás el formato, probá también un respaldo de la versión anterior.
- Interfaz. Para los flujos que cambies, verificá navegación por teclado, foco visible y el resultado en un ancho de pantalla móvil. Si cambia el arranque o la API, verificá también [el estado del contenedor](http://localhost:8080/health).
