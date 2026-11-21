import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, formatStudyDay, localDay, parseBackup, progress, readingPercent, reminderCalendar, reviewSchedule } from '../src/study-data.ts';

const session = {
  id: 'session', bookId: 'book', section: 'Capítulo 1', minutes: 10, step: 'done',
  questions: '¿Qué significa?', questionKind: 'concepto', deadline: null, notes: '',
  recall: 'Lo explicado en el capítulo.', gaps: '', exam: ['¿Qué aprendiste?', '¿Cómo lo aplicarías?'], closedOn: '2026-11-20',
};
const attempt = (day, remembered = true) => ({
  id: day, sessionId: session.id, question: 0, day, answer: 'Mi explicación.', remembered,
});

test('calcula avance proporcional y mantiene desconocido el total de libros anteriores', () => {
  assert.equal(readingPercent({}), null);
  assert.equal(readingPercent({ totalPages: 300, page: 100 }), 33);
  assert.equal(readingPercent({ totalPages: 300, page: 300 }), 100);
  assert.equal(readingPercent({ totalPages: 300 }), 0);
});

test('exporta fechas UTC y escapa títulos de libros en el recordatorio de calendario', () => {
  const reminder = { id: 'reminder', kind: 'study', at: Date.parse('2026-11-21T19:30:00-03:00') };
  const content = reminderCalendar({ title: 'Historia; capítulos, notas\nBEGIN:VEVENT' }, reminder, reminder.at);
  assert.match(content, /DTSTART:20261121T223000Z\r\n/);
  assert.match(content, /TRIGGER:PT0S/);
  assert.ok(content.includes('Historia\\; capítulos\\, notas\\nBEGIN:VEVENT'));
  assert.equal(content.match(/^BEGIN:VEVENT/gm).length, 1);
});

test('restaura secciones, avance, recordatorios y borradores independientes', () => {
  const books = [
    { id: 'book', title: 'Libro 1', author: 'Autora', totalPages: 100, page: 35,
      sections: [{ id: 'chapter', title: 'Capítulo 1', endPage: 40 }],
      reminder: { id: 'alert-1', at: Date.parse('2026-11-21T20:00:00Z'), kind: 'reading' } },
    { id: 'other', title: 'Libro 2', author: 'Otro autor' },
  ];
  const first = { ...session, step: 'scan', sectionId: 'chapter', closedOn: null };
  const second = { ...first, id: 'other-1', bookId: 'other', sectionId: undefined };
  const backup = { version: 1, books, study: { sessions: [first, second], attempts: [] } };
  assert.deepEqual(parseBackup(JSON.stringify(backup)), JSON.parse(JSON.stringify(backup)));
  assert.equal(parseBackup(JSON.stringify({ ...backup, books: [{ ...books[0], page: 101 }, books[1]] })), null);
  assert.equal(parseBackup(JSON.stringify({ ...backup, study: { ...backup.study,
    sessions: [first, { ...second, bookId: first.bookId }] } })), null);
});

test('usa días de Buenos Aires y atraviesa fin de mes', () => {
  assert.equal(localDay(Date.parse('2026-11-21T02:59:59Z')), '2026-11-20');
  assert.equal(localDay(Date.parse('2026-11-21T03:00:00Z')), '2026-11-21');
  assert.equal(addDays('2026-11-30', 2), '2026-12-02');
});

test('muestra la fecha guardada sin desplazarla por el huso horario', () => {
  assert.equal(formatStudyDay('2026-11-20'), '20 nov 2026');
});

test('respeta 2-3-5-7 y termina al cuarto acierto', () => {
  const attempts = [];
  for (const day of ['2026-11-22', '2026-11-25', '2026-11-30', '2026-12-07']) {
    assert.equal(reviewSchedule(session, 0, attempts).due, day);
    attempts.push(attempt(day));
  }
  assert.equal(reviewSchedule(session, 0, attempts).due, null);
});

test('un atraso desplaza el intervalo y una respuesta floja repite el tramo', () => {
  const delayed = attempt('2026-11-24');
  assert.equal(reviewSchedule(session, 0, [delayed]).due, '2026-11-27');
  assert.equal(reviewSchedule(session, 0, [attempt('2026-11-24', false)]).due, '2026-11-25');
  assert.equal(reviewSchedule(session, 0, [{ ...delayed, repeatByAi: true }]).stage, 0);
});

test('la racha cruza de semana, usa un comodín y se corta en la segunda falta semanal', () => {
  const study = { sessions: [{ ...session, closedOn: '2026-11-22' }], attempts: [attempt('2026-11-24')] };
  assert.deepEqual(progress(study, '2026-11-24'), { xp: 35, level: 1, streak: 2, wildcard: false });
  assert.equal(progress(study, '2026-11-26').streak, 0);
  assert.equal(progress(study, '2026-11-30').wildcard, true);
  assert.equal(progress({ sessions: [session, session, session, session], attempts: [] }, '2026-11-20').level, 2);
});

test('el respaldo valida vínculos, fechas, IDs y evaluaciones antes de restaurar', () => {
  const backup = {
    version: 1, books: [{ id: 'book', title: 'Un título', author: 'Una autora' }],
    study: { sessions: [session], attempts: [attempt('2026-11-22')] },
  };
  assert.deepEqual(parseBackup(JSON.stringify(backup)), backup);
  for (const malformed of [
    { ...backup, version: 99 },
    { ...backup, books: [] },
    { ...backup, study: { ...backup.study, attempts: [attempt('2026-11-21')] } },
    { ...backup, study: { ...backup.study, attempts: [attempt('2026-11-22'), attempt('2026-11-22')] } },
    { ...backup, study: { ...backup.study, sessions: [{ ...session, recallFeedback: { scores: [3, -1, 2] } }] } },
  ]) assert.equal(parseBackup(JSON.stringify(malformed)), null);
});
