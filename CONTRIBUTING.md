# Contribuir a The Dager Habit

Buscá primero si el problema o la idea ya tiene una [incidencia](https://github.com/matiasdante/dager-habit/issues). En un reporte de error incluí los pasos, lo que esperabas y lo que ocurrió. Usá datos de ejemplo y quitá claves, tokens y datos personales de capturas y registros.

## Preparar el entorno

1. Hacé un fork, clonalo y creá una rama como `fix/avance-de-lectura` desde `main`.
2. Con Node.js 26, ejecutá `npm ci` y `npm start` en `habit-web`. La web abre en [http://localhost:4200](http://localhost:4200).
3. Con el SDK de .NET 10, ejecutá `dotnet run --no-launch-profile --urls http://127.0.0.1:5080` en `habit-api`. Angular redirige las llamadas a la API a ese puerto. Las integraciones opcionales tienen su [configuración propia](habit-api/README.md).

## Verificar y abrir un PR

1. En `habit-web`, ejecutá `npm test` y `npm run build`. Desde la raíz, `docker compose up --build --wait` compila ambos componentes y levanta el contenedor.
2. Si cambiaste un flujo de la interfaz, probalo en el navegador. Si cambiaste el arranque o la API, verificá que [http://localhost:8080/health](http://localhost:8080/health) devuelva `{"status":"ok"}` en Docker.
3. Abrí un PR hacia `main` con un cambio acotado. Contá qué problema resuelve, cómo lo verificaste y enlazá la incidencia si corresponde. Para cambios visuales, adjuntá una captura.

Usá mensajes de commit como `fix: corrijo el cálculo del avance` y actualizá la documentación cuando cambie la forma de usar la app.
