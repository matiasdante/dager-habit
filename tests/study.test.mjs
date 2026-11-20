import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, localDay, parseBackup, progress, reviewSchedule } from '../src/study-data.ts';

const session = {
  id: 'session', bookId: 'book', section: 'Capítulo 1', minutes: 10, step: 'done',
  questions: '¿Qué significa?', questionKind: 'concepto', deadline: null, notes: '',
  recall: 'Lo explicado en el capítulo.', gaps: '', exam: ['¿Qué aprendiste?', '¿Cómo lo aplicarías?'], closedOn: '2026-11-20',
};
const attempt = (day, remembered = true) => ({
  id: day, sessionId: session.id, question: 0, day, answer: 'Mi explicación.', remembered,
});

test('usa días de Buenos Aires y atraviesa fin de mes', () => {
  assert.equal(localDay(Date.parse('2026-11-21T02:59:59Z')), '2026-11-20');
  assert.equal(localDay(Date.parse('2026-11-21T03:00:00Z')), '2026-11-21');
  assert.equal(addDays('2026-11-30', 2), '2026-12-02');
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
