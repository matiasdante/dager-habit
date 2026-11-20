# Dager Habit API

ASP.NET Core 10 sirve la evaluación con Groq. La biblioteca y el historial viven en la PWA. La API conserva un registro local de reservas del cupo diario, sin almacenar textos de estudio.

## Prueba local

1. Desde `habit-web`, ejecutá `npm ci`, `npm test` y `npm run build` con Node 26.
2. Desde `habit-api`, configurá `GROQ_API_KEY` en el entorno del proceso y generá un token de la app. En PowerShell 7:

   ```powershell
   $env:GROQ_API_KEY = Read-Host -MaskInput 'Clave nueva de Groq'
   $env:HABIT_API_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
   $env:HABIT_API_TOKEN | Set-Clipboard
   $env:HABIT_WEB_ROOT = (Resolve-Path ../habit-web/dist/habit-web/browser).Path
   dotnet run --no-launch-profile --urls http://127.0.0.1:5080
   ```

3. Abrí `http://127.0.0.1:5080/`. Entrá a Ajustes, pegá el token del portapapeles y hacé clic en **Conectar evaluación**.
4. Cerrá una sesión y elegí **Evaluar volcado** o **Evaluar examen** desde el historial. Desde Hoy podés evaluar un repaso respondido.

Para desarrollar la interfaz, `npm start` ejecuta Angular en el puerto 4200 y redirige `/api/` a `127.0.0.1:5080`.

`HABIT_DAILY_LIMIT` define el cupo global por día calendario de Buenos Aires. El valor predeterminado es 20. `GROQ_MODEL` permite cambiar el modelo y usa `openai/gpt-oss-20b` por defecto. Las credenciales se configuran en el entorno del servidor.

## Entrega interna

El runner debe tener los dos repositorios en carpetas contiguas. Desde `habit-api`, construí y exportá el runtime compilado:

```sh
docker build --build-context web=../habit-web -t "$DCS_IMAGE" .
docker image save -o image.tar "$DCS_IMAGE"
sha256sum image.tar docker-compose.yaml release.env > SHA256SUMS
```

Antes de generar los checksums, prepará `release.env` con el tag `DCS_IMAGE`, el puerto libre `HABIT_HOST_PORT` y el path absoluto `HABIT_ENV_FILE` al archivo de credenciales que ya existe en el servidor. El archivo de credenciales debe definir `HABIT_API_TOKEN` y `GROQ_API_KEY`.

En destino, verificá los checksums, cargá `image.tar` con `docker image load` y levantá el release con `docker compose --env-file release.env up -d --no-build --pull never --wait`. Configurá el proxy HTTPS del dominio para apuntar a `127.0.0.1:HABIT_HOST_PORT`. La API y la web se sirven juntos. Comprobá `/health` y completá una instalación en Chrome para Android.

[Formato de evaluación de Groq](https://console.groq.com/docs/structured-outputs)
