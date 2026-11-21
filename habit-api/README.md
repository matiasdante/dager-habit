# Dager Habit API

ASP.NET Core 10 sirve la PWA, la búsqueda en Open Library y las evaluaciones con el proveedor de IA elegido. La biblioteca, los recordatorios y el historial se guardan en el dispositivo. La API registra las reservas del cupo diario.

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

## Proveedores de IA

Configurá en el servidor un modelo por cada proveedor que quieras habilitar. El selector de Ajustes muestra los proveedores configurados. Para cambiar de modelo en la web, ingresá su identificador exacto. En OpenRouter se acepta el identificador de cualquier modelo de chat habilitado para tu cuenta. El modelo tiene que poder devolver la estructura JSON de evaluación.

| Proveedor | Variables |
| --- | --- |
| Groq | `GROQ_API_KEY`, `GROQ_MODEL` (opcional) |
| DeepSeek | `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` |
| OpenRouter | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` |
| Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| OpenAI | `OPENAI_API_KEY`, `OPENAI_MODEL` |
| Ollama | `OLLAMA_MODEL`, `OLLAMA_BASE_URL` si el servidor está en otro host, `OLLAMA_API_KEY` si pide autenticación |
| LM Studio | `LMSTUDIO_MODEL`, `LMSTUDIO_BASE_URL` si el servidor está en otro host, `LMSTUDIO_API_KEY` si pide autenticación |
| API compatible | `COMPATIBLE_BASE_URL` incluye el prefijo de la API, por ejemplo `https://mi-proveedor.example/v1/`. Usá también `COMPATIBLE_MODEL` y, si corresponde, `COMPATIBLE_API_KEY`. |

`AI_DEFAULT_PROVIDER` selecciona el proveedor inicial. Para OpenRouter, LM Studio y la API compatible, podés fijar el modo con `OPENROUTER_FORMAT`, `LMSTUDIO_FORMAT` o `COMPATIBLE_FORMAT`. Los valores son `text`, `json_object` y `json_schema`. El modo `text` pide JSON en el prompt y la API lo valida. Si Ollama o LM Studio corren fuera del contenedor, configurá una URL que el contenedor pueda alcanzar.

## Catálogo de libros

Open Library permite buscar por título, autor o ISBN y aporta una descripción breve, portada y páginas cuando el catálogo tiene esos datos. El ISBN ayuda a identificar la edición. Configurá un correo operativo en `OPENLIBRARY_CONTACT` para identificar la integración ante Open Library. El total de páginas se puede corregir en la ficha del libro.

## NotebookLM

`/#/notebook` permite descargar el resumen de un libro e incorporarlo manualmente a NotebookLM personal. La sincronización automática usa Google Cloud y requiere una licencia activa de Gemini Notebook Enterprise, el rol Cloud NotebookLM User y acceso de escritura al notebook. Google AI Pro o Ultra ofrece beneficios en NotebookLM personal. El acceso de sincronización se verifica consultando la API Enterprise con las credenciales de la cuenta que inició sesión. [Licencias y permisos](https://docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/set-up-notebooklm) · [Planes personales](https://support.google.com/gemininotebook/answer/16213268)

1. Habilitá la API de Discovery Engine en el proyecto Enterprise y asigná la licencia y el rol al usuario de prueba.
2. Creá un cliente OAuth de aplicación web y registrá la URL `https://TU-DOMINIO/api/notebook/callback`. Configurá `NOTEBOOK_PROJECT_NUMBER`, `NOTEBOOK_LOCATION`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` y `GOOGLE_OAUTH_REDIRECT_URI` en el servidor.
3. Conectá la app con su token, abrí Notebook y elegí **Iniciar sesión con Google**. Abrí el notebook de destino en Enterprise para que figure entre los recientes. Después podés enviar el resumen como fuente de texto.

Google se desvincula al cerrar la conexión o al vencer el token. Volvé a iniciar sesión si reiniciás la API. Configurá el proxy para omitir los parámetros de consulta del callback de OAuth en los registros de acceso.

## Entrega interna

Desde `habit-api`, construí la imagen con la web de `../habit-web` y exportala:

```sh
docker build --build-context web=../habit-web -t "$DCS_IMAGE" .
docker image save -o image.tar "$DCS_IMAGE"
sha256sum image.tar docker-compose.yaml release.env > SHA256SUMS
```

Antes de generar los checksums, prepará `release.env` con el tag `DCS_IMAGE`, el puerto libre `HABIT_HOST_PORT` y el path absoluto `HABIT_ENV_FILE` al archivo de credenciales que ya existe en el servidor. Ese archivo define `HABIT_API_TOKEN` y las variables del proveedor de IA y de Google Cloud que quieras habilitar.

En destino, verificá los checksums, cargá `image.tar` con `docker image load` y levantá el release con `docker compose --env-file release.env up -d --no-build --pull never --wait`. Configurá el proxy HTTPS del dominio para apuntar a `127.0.0.1:HABIT_HOST_PORT`. La API y la web se sirven juntos. Comprobá `/health` y completá una instalación en Chrome para Android.

[Formato de evaluación de Groq](https://console.groq.com/docs/structured-outputs)
