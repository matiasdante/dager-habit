export interface Book {
  id: string;
  title: string;
  author: string;
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

  const bookIds = new Set<string>();
  for (const book of value.books) {
    if (!object(book) || !text(book.id, 80, true) || bookIds.has(book.id) ||
        !text(book.title, 150, true) || !text(book.author, 100, true)) return null;
    bookIds.add(book.id);
  }

  const sessions = new Map<string, Session>();
  const steps = ['scan', 'read', 'recall', 'exam', 'done'];
  let hasDraft = false;
  for (const session of value.study.sessions) {
    if (!object(session) || !text(session.id, 80, true) || sessions.has(session.id) ||
        typeof session.bookId !== 'string' || !bookIds.has(session.bookId) || !text(session.section, 160, true) ||
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
      if (hasDraft) return null;
      hasDraft = true;
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
