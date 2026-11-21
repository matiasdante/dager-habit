import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));
const token = 'test-token-browser-for-dager-habit-000000';
const book = { id: 'book', title: 'Álgebra práctica', author: 'Ana Pérez' };
const session = {
  id: 'session', bookId: book.id, section: 'Vectores', minutes: 10, step: 'done',
  questions: '¿Qué representa un vector?', questionKind: 'concepto', deadline: null, notes: '',
  recall: 'Representa magnitud y dirección.', gaps: '', exam: ['¿Qué es un vector?', '¿Cómo se suma?'], closedOn: '2026-11-15',
};
let upstream;
let api;
let browser;
let directory;
let baseUrl;

function fixture(request, response) {
  const url = new URL(request.url, 'http://localhost');
  const first = { key: '/books/OL11M', title: 'Edición en español', languages: [{ key: '/languages/spa' }],
    publish_date: 'Noviembre de 2023', number_of_pages: 240, works: [{ key: '/works/OL1W' }] };
  const second = { key: '/books/OL12M', title: 'English edition', languages: [{ key: '/languages/eng' }],
    publish_date: '2005', number_of_pages: 320, works: [{ key: '/works/OL1W' }] };
  let payload;
  if (url.pathname === '/search.json') {
    const query = url.searchParams.get('q');
    if (query === 'catálogo caído') {
      response.writeHead(503).end();
      return;
    }
    payload = { docs: query === 'isbn:9780306406157' ? [{
      key: '/works/OL1W', title: 'Libro de catálogo', author_name: ['Autora de catálogo'],
      editions: { docs: [{ key: '/books/OL12M', title: 'English edition' }] },
    }] : [] };
  } else if (url.pathname === '/works/OL1W/editions.json') {
    payload = { size: 2, entries: url.searchParams.get('offset') === '0' ? [first] : [second] };
  } else if (url.pathname === '/works/OL1W.json') {
    payload = { description: 'Un resumen de ejemplo.' };
  } else if (url.pathname === '/books/OL11M.json') {
    payload = first;
  } else if (url.pathname === '/books/OL12M.json') {
    payload = second;
  } else if (url.pathname === '/openai/v1/chat/completions') {
    payload = { choices: [{ message: { content: '{"scores":[9,9,9]}' } }] };
  } else {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dager-habit-browser-'));
  upstream = createServer(fixture);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamUrl = 'http://127.0.0.1:' + upstream.address().port;
  api = spawn('dotnet', [
    resolve(process.env.HABIT_TEST_API_DLL ?? join(root, 'habit-api/bin/Debug/net10.0/Habit.Api.dll')),
    '--urls', 'http://127.0.0.1:0',
  ], {
    cwd: directory,
    env: {
      ...process.env,
      ASPNETCORE_ENVIRONMENT: 'Development',
      DOTNET_ENVIRONMENT: 'Development',
      HABIT_WEB_ROOT: resolve(process.env.HABIT_TEST_WEB_ROOT ?? join(root, 'habit-web/dist/habit-web/browser')),
      HABIT_API_TOKEN: token,
      HABIT_DAILY_LIMIT: '1',
      HABIT_QUOTA_PATH: join(directory, 'quota.log'),
      CATALOG_DEV_URL: upstreamUrl,
      AI_DEFAULT_PROVIDER: 'groq',
      GROQ_API_KEY: 'test-provider-key',
      GROQ_MODEL: 'fixture-model',
      GROQ_DEV_URL: upstreamUrl,
      Logging__LogLevel__Microsoft_Hosting_Lifetime: 'Information',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const lines = createInterface({ input: api.stdout });
  lines.on('line', line => { logs += line + '\n'; });
  api.stderr.on('data', data => { logs += data.toString(); });
  const controller = new AbortController();
  try {
    baseUrl = await Promise.race([
      (async () => {
        for await (const line of lines) {
          const address = line.match(/Now listening on: (http:\/\/127\.0\.0\.1:\d+)/);
          if (address) return address[1];
        }
        throw new Error('La API se cerró al arrancar.\n' + logs);
      })(),
      delay(20_000, null, { signal: controller.signal }).then(() => { throw new Error('La API no arrancó.\n' + logs); }),
    ]);
  } finally { controller.abort(); }
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
}, { timeout: 25_000 });

after(async () => {
  await browser?.close();
  if (api && api.exitCode === null && api.signalCode === null) {
    api.kill();
    await once(api, 'exit');
  }
  if (upstream?.listening) await new Promise(resolveClose => upstream.close(resolveClose));
  if (directory) await rm(directory, { recursive: true, force: true });
});

const go = (page, hash = '/') => page.goto(baseUrl + '/#' + hash);
const button = (page, name) => page.getByRole('button', { name, exact: true });
const heading = (page, name) => page.getByRole('heading', { name, exact: true });
const visible = locator => locator.waitFor({ state: 'visible' });

async function createContext(t, options) {
  const context = await browser.newContext({ reducedMotion: 'reduce', ...options });
  t.after(() => context.close());
  return context;
}

async function newPage(context, date) {
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  if (date) await page.clock.setFixedTime(new Date(date));
  return page;
}

async function selectBackup(page, backup) {
  const buffer = Buffer.isBuffer(backup) ? backup : Buffer.from(JSON.stringify(backup));
  await page.locator('#backup-file').setInputFiles({ name: 'respaldo.json', mimeType: 'application/json', buffer });
}

async function restore(page, backup) {
  await go(page, '/ajustes');
  await selectBackup(page, backup);
  await button(page, 'Confirmar restauración').click();
  await visible(page.getByText('Respaldo restaurado.'));
}

async function downloadBackup(page, name = 'Exportar respaldo') {
  const download = page.waitForEvent('download');
  await button(page, name).click();
  return readFile(await (await download).path());
}

test('busca localmente sin tildes y permite actualizar, editar y archivar un libro', { timeout: 30_000 }, async t => {
  const context = await createContext(t, { serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const page = await newPage(context);
  await go(page);
  await page.getByText('Agregar manualmente', { exact: true }).click();
  await page.getByLabel('Título', { exact: true }).fill(book.title);
  await page.getByLabel('Autor', { exact: true }).fill(book.author);
  await button(page, 'Agregar a la biblioteca').click();
  const query = page.getByRole('searchbox');
  await query.fill('alge per');
  await visible(page.locator('.local-results').getByRole('link', { name: /Álgebra práctica/ }));
  await query.press('Enter');
  await visible(heading(page, book.title));
  await page.getByLabel('Páginas totales').fill('100');
  await button(page, 'Guardar avance').click();
  await visible(page.getByText('Avance actualizado.'));
  await page.getByLabel('Nombre de la sección').fill('Vectores');
  await page.getByLabel('Página final (opcional)').fill('40');
  await button(page, 'Agregar sección').click();
  await visible(page.getByText('Sección agregada.'));

  await go(page);
  const row = page.locator('.book-list > li').filter({ hasText: book.title });
  await row.locator('summary').click();
  await row.getByLabel('Última página leída').fill('15');
  await row.getByRole('button', { name: 'Guardar página' }).click();
  await visible(row.getByText('15 %'));
  await row.getByRole('button', { name: 'Marcar «Vectores» como leída' }).click();
  await visible(row.getByText('40 %'));

  await query.fill('vect');
  await query.press('Enter');
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Vectores');
  await page.getByText('Editar ficha', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Título', exact: true }).fill('Álgebra aplicada');
  await page.getByLabel('Año de la edición (opcional)').fill('2019');
  await page.getByLabel('Idioma de la edición (opcional)').selectOption('spa');
  await button(page, 'Guardar ficha').click();
  await visible(heading(page, 'Álgebra aplicada'));
  await button(page, 'Archivar libro').click();
  await visible(page.getByText('Libro archivado. Podés recuperarlo desde la colección.'));

  await go(page);
  await button(page, 'Archivados (1)').click();
  await page.locator('.book-list').getByRole('link', { name: /Álgebra aplicada/ }).click();
  await visible(heading(page, 'Álgebra aplicada'));
  await page.getByText('Editar ficha', { exact: true }).click();
  await button(page, 'Devolver a la colección').click();
  await visible(page.getByText('Libro devuelto a la colección.'));
  await go(page);
  await button(page, 'Activos').click();
  await button(page, 'Limpiar búsqueda').click();
  await visible(heading(page, 'Abiertos recientemente'));
  await visible(page.locator('.local-results').getByRole('link', { name: /Álgebra aplicada/ }));
});

test('estudia y responde offline, conserva borradores y evita duplicados entre pestañas', { timeout: 45_000 }, async t => {
  const context = await createContext(t);
  const page = await newPage(context, '2026-11-21T16:00:00Z');
  await go(page);
  await visible(heading(page, 'Colección'));
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  assert.equal(await page.evaluate(() => fetch('/index.html').then(response => response.ok)), true);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await visible(heading(page, 'Colección'));
  const query = page.getByRole('searchbox');
  await query.fill('habitos at');
  await query.press('Enter');
  await visible(heading(page, 'Hábitos atómicos'));
  await button(page, 'Empezar sesión').click();
  await page.getByLabel('Sección', { exact: true }).fill('Práctica offline');
  await button(page, 'Preparar lectura').click();
  await page.getByLabel('¿Qué querés entender?').fill('¿Qué es un hábito?');
  await page.getByText('Guardando borrador…').waitFor({ state: 'hidden' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.getByLabel('¿Qué querés entender?').inputValue(), '¿Qué es un hábito?');
  await button(page, 'Pasar a la lectura').click();

  await button(page, 'Iniciar temporizador').click();
  await visible(button(page, 'Pausar temporizador'));
  await page.clock.setFixedTime(new Date('2026-11-21T16:03:00Z'));
  await button(page, 'Pausar temporizador').click();
  await visible(button(page, 'Reanudar temporizador'));
  assert.equal(await page.getByRole('timer').innerText(), '07:00');
  await page.clock.setFixedTime(new Date('2026-11-21T17:00:00Z'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await button(page, 'Reanudar temporizador').click();
  assert.equal(await page.getByRole('timer').innerText(), '07:00');

  await button(page, 'Marcar lectura hecha').click();
  await page.locator('#recall-text').fill('Una acción repetida en un contexto.');
  await page.locator('form').filter({ has: page.locator('#recall-text') }).getByRole('button').click();
  await page.locator('#exam-0').fill('¿Qué es un hábito?');
  await page.locator('#exam-1').fill('¿Cómo influyen las señales?');
  await page.locator('form').filter({ has: page.locator('#exam-0') }).getByRole('button', { name: /cerrar|terminar|completar/i }).click();
  await visible(page.getByText(/Sesión completada/));
  await go(page, '/hoy');
  await page.getByText('23 nov 2026 · 2 repasos', { exact: true }).click();
  await visible(page.getByText(/Práctica offline · 2/));

  await page.clock.setFixedTime(new Date('2026-11-23T16:00:00Z'));
  await button(page, 'Ir a 2 repasos pendientes').click();
  await page.waitForFunction(() => document.activeElement?.textContent.includes('¿Qué es un hábito?'));
  const first = button(page, 'Responder ¿Qué es un hábito?');
  const second = button(page, 'Responder ¿Cómo influyen las señales?');
  await first.click();
  await page.getByLabel('Tu respuesta').fill('Mi respuesta en curso');
  await page.getByText('Guardando borrador…').waitFor({ state: 'hidden' });
  await second.click();
  await first.click();
  await page.waitForFunction(() => document.querySelector('#review-answer')?.value === 'Mi respuesta en curso');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await first.click();
  assert.equal(await page.getByLabel('Tu respuesta').inputValue(), 'Mi respuesta en curso');

  const other = await newPage(context, '2026-11-23T16:00:00Z');
  await go(other, '/hoy');
  await button(other, 'Responder ¿Qué es un hábito?').click();
  assert.equal(await other.getByLabel('Tu respuesta').inputValue(), 'Mi respuesta en curso');
  await Promise.all([page, other].map(tab => tab.getByRole('button', { name: 'Recordé', exact: true })
    .evaluate(element => element.click())));
  await visible(page.getByRole('heading', { name: '¿Cómo influyen las señales?', exact: true }));
  await button(page, 'Ir a 1 repaso pendiente').waitFor();
  await go(page, '/ajustes');
  const backup = JSON.parse(await downloadBackup(page));
  assert.equal(backup.study.attempts.length, 1);
  assert.deepEqual(backup.study.reviewDrafts, []);
});

test('restaura respaldos de más de 10 MB en otro perfil y conserva los datos ante un archivo inválido', { timeout: 40_000 }, async t => {
  const context = await createContext(t, { serviceWorkers: 'block' });
  const page = await newPage(context);
  const fixtureBackup = {
    version: 1,
    books: [book],
    study: {
      sessions: Array.from({ length: 2200 }, (_, index) => ({ ...session, id: 'session-' + index, notes: 'a'.repeat(5000) })),
      attempts: [],
    },
  };
  await restore(page, fixtureBackup);
  const backup = await downloadBackup(page);
  assert.ok(backup.byteLength > 10 * 1024 * 1024);
  const other = await newPage(await createContext(t, { serviceWorkers: 'block' }));
  await go(other, '/ajustes');
  await selectBackup(other, backup);
  await visible(heading(other, 'Confirmá la restauración'));
  await visible(other.getByText('2200', { exact: true }));
  assert.ok(JSON.parse(await downloadBackup(other, 'Descargar copia actual')).books.length > 1);
  await button(other, 'Confirmar restauración').click();
  await visible(other.getByText('Respaldo restaurado.'));
  await selectBackup(other, { ...fixtureBackup, books: [] });
  await visible(other.getByText('El archivo no es un respaldo válido de The Dager Habit.'));
  assert.deepEqual(JSON.parse(await downloadBackup(other)), fixtureBackup);
});

test('elige la edición por ISBN y muestra fallas del catálogo y de las evaluaciones', { timeout: 40_000 }, async t => {
  const context = await createContext(t, { serviceWorkers: 'block' });
  const page = await newPage(context);
  await go(page);
  const query = page.getByRole('searchbox');
  await query.fill('catálogo caído');
  await button(page, 'Buscar en Open Library').click();
  await visible(page.getByText(/No se pudo buscar en Open Library/));
  await query.fill('978 0–306-40615-7');
  await button(page, 'Buscar en Open Library').click();
  await button(page, 'Ver ediciones de English edition').click();
  await visible(page.getByText('inglés · 2005 · 320 págs.'));
  await visible(page.getByText('español · 2023 · 240 págs.'));
  assert.match(await page.locator('.edition-picker li').first().innerText(), /English edition/);
  await button(page, 'Cargar más ediciones').click();
  await button(page, 'Cargar más ediciones').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.edition-picker li').count(), 2);
  await button(page, 'Agregar English edition').click();
  await visible(heading(page, 'English edition'));
  await visible(page.getByText('0 de 320 páginas'));

  await go(page);
  await button(page, 'Ver ediciones de English edition').click();
  await visible(page.getByRole('link', { name: 'Abrir ficha de English edition' }));

  await restore(page, { version: 1, books: [book], study: { sessions: [session], attempts: [] } });
  const connect = async () => {
    await page.getByLabel('Token de la app').fill(token);
    await button(page, 'Conectar evaluación').click();
    await visible(button(page, 'Desconectar evaluación'));
  };
  await connect();
  await go(page, '/estudiar');
  await page.getByText(book.title + ' · ' + session.section, { exact: true }).click();
  await context.clearCookies();
  await button(page, 'Evaluar volcado').click();
  await visible(page.getByText('Volvé a conectar la app en Ajustes.'));

  await go(page, '/ajustes');
  await connect();
  await go(page, '/estudiar');
  await page.getByText(book.title + ' · ' + session.section, { exact: true }).click();
  await button(page, 'Evaluar volcado').click();
  await visible(page.getByText('La evaluación no está disponible. Podés reintentar después.'));
  await button(page, 'Evaluar volcado').click();
  await visible(page.getByText('Se alcanzó el cupo de evaluaciones. Probá más tarde.'));
});
