export interface Book {
  id: string;
  title: string;
  author: string;
  catalogId?: string;
  summary?: string;
  coverId?: number;
  totalPages?: number;
  page?: number;
  sections?: BookSection[];
  reminder?: ReadingReminder;
}

export interface BookSection {
  id: string;
  title: string;
  endPage?: number;
}

export interface ReadingReminder {
  id: string;
  at: number;
  kind: 'reading' | 'study';
}

export interface Feedback {
  scores: [number, number, number] | null;
  comment: string;
  action: string;
  possibleError: string;
}

export interface Session {
  id: string;
  bookId: string;
  section: string;
  sectionId?: string;
  minutes: 10 | 15;
  step: 'scan' | 'read' | 'recall' | 'exam' | 'done';
  questions: string;
  questionKind: 'concepto' | 'método' | 'crítica';
  deadline: number | null;
  notes: string;
  recall: string;
  gaps: string;
  exam: string[];
  closedOn: string | null;
  recallFeedback?: Feedback;
  examFeedback?: Feedback;
}

export interface Attempt {
  id: string;
  sessionId: string;
  question: number;
  day: string;
  answer: string;
  remembered: boolean;
  repeatByAi?: boolean;
  feedback?: Feedback;
}

export interface Study {
  sessions: Session[];
  attempts: Attempt[];
}

export const emptyStudy = (): Study => ({ sessions: [], attempts: [] });

export const maxPages = 100_000;

export function readingPercent(book: Book): number | null {
  if (!book.totalPages) return null;
  return Math.floor((book.page ?? 0) * 100 / book.totalPages);
}

export function coverUrl(coverId: number): string {
  return 'https://covers.openlibrary.org/b/id/' + coverId + '-M.jpg?default=false';
}

const calendarStamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const calendarText = (text: string) => text.replace(/\\/g, '\\\\').replace(/\r?\n|\r/g, '\\n')
  .replace(/[,;]/g, character => '\\' + character);
const encoder = new TextEncoder();

export function reminderCalendar(book: Book, reminder: ReadingReminder, now = Date.now()): string {
  const start = calendarStamp(new Date(reminder.at));
  const end = calendarStamp(new Date(reminder.at + 15 * 60_000));
  const title = calendarText((reminder.kind === 'study' ? 'Continuar estudio · ' : 'Continuar lectura · ') + book.title);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Dager Habit//Recordatorios//ES',
    'BEGIN:VEVENT', 'UID:' + reminder.id + '@dager-habit', 'DTSTAMP:' + calendarStamp(new Date(now)),
    'DTSTART:' + start, 'DTEND:' + end, 'SUMMARY:' + title,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT0S', 'DESCRIPTION:' + title,
    'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(line => {
    let result = '';
    let bytes = 0;
    for (const character of line) {
      const size = encoder.encode(character).length;
      if (bytes + size > 75) {
        result += '\r\n ';
        bytes = 1;
      }
      result += character;
      bytes += size;
    }
    return result;
  }).join('\r\n') + '\r\n';
}

const calendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function localDay(now = Date.now()): string {
  const parts = calendar.formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}

export function addDays(day: string, count: number): string {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

const studyDayFormat = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeZone: 'UTC' });

export function formatStudyDay(day: string): string {
  return studyDayFormat.format(new Date(day + 'T00:00:00Z'));
}

export function reviewSchedule(session: Session, question: number, attempts: Attempt[]) {
  let due = session.closedOn ? addDays(session.closedOn, 2) : null;
  let stage = 0;
  let latest: Attempt | undefined;
  for (const attempt of attempts) {
    if (attempt.sessionId !== session.id || attempt.question !== question) continue;
    latest = attempt;
    if (attempt.remembered && !attempt.repeatByAi) stage++;
    due = stage === 4 ? null : addDays(attempt.day, !attempt.remembered || attempt.repeatByAi ? 1 : [0, 3, 5, 7][stage]);
  }
  return { due, stage, latest };
}

export function sessionXp(session: Session): number {
  const base = { scan: 0, read: 5, recall: 10, exam: 20, done: 30 };
  return base[session.step] + bonus(session.recallFeedback) + bonus(session.examFeedback);
}

export function bonus(feedback?: Feedback): number {
  return feedback?.scores?.reduce((sum, score) => sum + score, 0) ?? 0;
}

export function progress(study: Study, today: string) {
  const active = new Set([
    ...study.sessions.flatMap(session => session.closedOn ? [session.closedOn] : []),
    ...study.attempts.map(attempt => attempt.day),
  ].filter(day => day <= today));
  const first = [...active].sort()[0];
  const weekOf = (day: string) => addDays(day, -((new Date(day).getUTCDay() + 6) % 7));
  const currentWeek = weekOf(today);
  let streak = 0;
  let usedWeek = '';
  for (let day = first; day && day <= today; day = addDays(day, 1)) {
    if (active.has(day)) {
      streak++;
    } else if (day < today && streak > 0) {
      const week = weekOf(day);
      if (week === usedWeek) streak = 0;
      else usedWeek = week;
    }
  }

  const xp = study.sessions.reduce((sum, session) => sum + sessionXp(session), 0)
    + study.attempts.reduce((sum, attempt) => sum + 5 + bonus(attempt.feedback), 0);
  return { xp, level: Math.floor(xp / 100) + 1, streak, wildcard: usedWeek !== currentWeek };
}

export function readStudy(database: IDBDatabase): Promise<Study> {
  return new Promise((resolve, reject) => {
    const request = database.transaction('study').objectStore('study').get('current');
    request.onsuccess = () => resolve(request.result ?? emptyStudy());
    request.onerror = () => reject(request.error);
  });
}

export function updateStudy(database: IDBDatabase, update: (current: Study) => void): Promise<Study> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('study', 'readwrite');
    const store = transaction.objectStore('study');
    const request = store.get('current');
    let next: Study;
    request.onsuccess = () => {
      next = request.result ?? emptyStudy();
      update(next);
      store.put(next, 'current');
    };
    transaction.oncomplete = () => resolve(next);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function makeBackup(database: IDBDatabase): Promise<Backup> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['books', 'study']);
    const books = transaction.objectStore('books').getAll();
    const study = transaction.objectStore('study').get('current');
    transaction.oncomplete = () => resolve({ version: 1, books: books.result, study: study.result ?? emptyStudy() });
    transaction.onabort = () => reject(transaction.error);
  });
}

export function restoreBackup(database: IDBDatabase, backup: Backup): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(['books', 'study'], 'readwrite');
    const books = transaction.objectStore('books');
    books.clear();
    for (const book of backup.books) books.add(book);
    transaction.objectStore('study').put(backup.study, 'current');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

export function editBook(database: IDBDatabase, id: string, edit: (book: Book) => Book | null): Promise<Book[]> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('books', 'readwrite');
    const books = transaction.objectStore('books');
    const get = books.get(id);
    let read: IDBRequest<Book[]>;
    get.onsuccess = () => {
      const book = get.result as Book | undefined;
      const updated = book && edit(book);
      if (!updated) {
        transaction.abort();
        return;
      }
      books.put(updated);
      read = books.getAll();
    };
    transaction.oncomplete = () => resolve(read.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

interface Backup {
  version: 1;
  books: Book[];
  study: Study;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number, required = false): value is string {
  return typeof value === 'string' && value.length <= max && (!required || !!value.trim());
}

function date(value: unknown): value is string {
  return typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    && addDays(value, 0) === value;
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function validBookMetadata(book: Record<string, unknown>): boolean {
  if ((book.catalogId !== undefined && !text(book.catalogId, 120, true)) ||
      (book.summary !== undefined && !text(book.summary, 700)) ||
      (book.coverId !== undefined && !integer(book.coverId, 1, 2_147_483_647)) ||
      (book.totalPages !== undefined && !integer(book.totalPages, 1, maxPages)) ||
      (book.page !== undefined && (!integer(book.totalPages, 1, maxPages) || !integer(book.page, 0, book.totalPages)))) return false;
  if (book.reminder !== undefined && (!object(book.reminder) || !text(book.reminder.id, 80, true) ||
      !/^[\w-]+$/.test(book.reminder.id) || !integer(book.reminder.at, 0, Date.UTC(2100, 0, 1)) ||
      (book.reminder.kind !== 'reading' && book.reminder.kind !== 'study'))) return false;
  if (book.sections === undefined) return true;
  if (!Array.isArray(book.sections) || book.sections.length > 250) return false;
  const ids = new Set<string>();
  for (const section of book.sections) {
    if (!object(section) || !text(section.id, 80, true) || ids.has(section.id) || !text(section.title, 160, true) ||
        (section.endPage !== undefined && !integer(section.endPage, 1, maxPages))) return false;
    ids.add(section.id);
  }
  return true;
}

export function isFeedback(value: unknown): value is Feedback {
  return object(value) && (value.scores === null ||
    (Array.isArray(value.scores) && value.scores.length === 3 &&
      value.scores.every(score => Number.isInteger(score) && score >= 0 && score <= 3))) &&
    text(value.comment, 1000, true) && text(value.action, 1000, true) && text(value.possibleError, 1000);
}

export function parseBackup(input: string): Backup | null {
  let value: unknown;
  try { value = JSON.parse(input); } catch { return null; }
  if (!object(value) || value.version !== 1 || !Array.isArray(value.books) ||
      !object(value.study) || !Array.isArray(value.study.sessions) || !Array.isArray(value.study.attempts)) return null;

  const bookIds = new Map<string, Book>();
  for (const book of value.books) {
    if (!object(book) || !text(book.id, 80, true) || bookIds.has(book.id) ||
        !text(book.title, 150, true) || !text(book.author, 100, true) || !validBookMetadata(book)) return null;
    bookIds.set(book.id, book as unknown as Book);
  }

  const sessions = new Map<string, Session>();
  const steps = ['scan', 'read', 'recall', 'exam', 'done'];
  const drafts = new Set<string>();
  for (const session of value.study.sessions) {
    if (!object(session) || !text(session.id, 80, true) || sessions.has(session.id) ||
        typeof session.bookId !== 'string' || !bookIds.has(session.bookId) || !text(session.section, 160, true) ||
        (session.sectionId !== undefined && !bookIds.get(session.bookId)?.sections?.some(section => section.id === session.sectionId)) ||
        (session.minutes !== 10 && session.minutes !== 15) ||
        typeof session.step !== 'string' || !steps.includes(session.step) ||
        typeof session.questionKind !== 'string' || !['concepto', 'método', 'crítica'].includes(session.questionKind) ||
        !text(session.questions, 3000, session.step !== 'scan') || !text(session.notes, 5000) ||
        !text(session.recall, 4000, ['exam', 'done'].includes(session.step)) || !text(session.gaps, 1500) ||
        (session.deadline !== null && (typeof session.deadline !== 'number' || !Number.isSafeInteger(session.deadline) || session.deadline < 0)) ||
        !Array.isArray(session.exam) || session.exam.length < 2 || session.exam.length > 4 ||
        !session.exam.every(question => text(question, 600, session.step === 'done')) ||
        (session.step === 'done' ? !date(session.closedOn) || session.exam.length < 2 || new Set(session.exam).size !== session.exam.length : session.closedOn !== null) ||
        (session.recallFeedback !== undefined && (!['exam', 'done'].includes(session.step) || !isFeedback(session.recallFeedback))) ||
        (session.examFeedback !== undefined && (session.step !== 'done' || !isFeedback(session.examFeedback)))) return null;
    if (session.step !== 'done') {
      if (drafts.has(session.bookId)) return null;
      drafts.add(session.bookId);
    }
    sessions.set(session.id, session as unknown as Session);
  }

  const attempts: Attempt[] = [];
  const ids = new Set<string>();
  for (const attempt of value.study.attempts) {
    if (!object(attempt) || !text(attempt.id, 80, true) || ids.has(attempt.id) ||
        typeof attempt.sessionId !== 'string' || typeof attempt.question !== 'number' ||
        !Number.isInteger(attempt.question) || !date(attempt.day) ||
        !text(attempt.answer, 4000, true) || typeof attempt.remembered !== 'boolean' ||
        (attempt.feedback !== undefined && !isFeedback(attempt.feedback)) ||
        (attempt.repeatByAi !== undefined && (attempt.repeatByAi !== true || !isFeedback(attempt.feedback) ||
          !attempt.feedback.scores || bonus(attempt.feedback) > 3))) return null;
    const session = sessions.get(attempt.sessionId);
    if (!session?.closedOn || !session.exam[attempt.question]) return null;
    const { due } = reviewSchedule(session, attempt.question, attempts);
    if (!due || attempt.day < due) return null;
    ids.add(attempt.id);
    attempts.push(attempt as unknown as Attempt);
  }
  return value as unknown as Backup;
}
