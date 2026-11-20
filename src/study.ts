import { Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import {
  Attempt, Book, Feedback, Session, Study, bonus, emptyStudy, isFeedback, localDay,
  makeBackup, parseBackup, progress, readStudy, restoreBackup, reviewSchedule, updateStudy,
} from './study-data';

type EvaluationType = 'brain_dump' | 'exam' | 'review';

@Component({ selector: 'app-study', templateUrl: './study.html', imports: [NgTemplateOutlet] })
export class StudyPanel {
  readonly feedbackXp = bonus;
  readonly database = input.required<IDBDatabase>();
  readonly books = input.required<Book[]>();
  readonly booksRestored = output<Book[]>();
  readonly view = input.required<'today' | 'study' | 'settings'>();
  readonly openStudy = output<void>();

  readonly study = signal<Study>(emptyStudy());
  readonly now = signal(Date.now());
  readonly today = computed(() => localDay(this.now()));
  readonly draft = computed(() => this.study().sessions.find(session => session.step !== 'done'));
  readonly completed = computed(() => this.study().sessions.filter(session => session.step === 'done').slice().reverse());
  readonly stats = computed(() => progress(this.study(), this.today()));
  readonly reviewing = signal('');
  readonly status = signal('');
  readonly error = signal('');
  readonly loaded = signal(false);
  readonly saving = signal(false);
  readonly pendingWrites = signal(0);
  readonly evaluating = signal('');
  readonly connected = signal(false);
  readonly authBusy = signal(false);
  readonly restoreFile = signal<{ name: string; backup: NonNullable<ReturnType<typeof parseBackup>> } | null>(null);

  readonly due = computed(() => this.completed().flatMap(session => session.exam.flatMap((question, index) => {
    const schedule = reviewSchedule(session, index, this.study().attempts);
    return schedule.due && schedule.due <= this.today()
      ? [{ key: session.id + '/' + index, session, index, question, ...schedule }] : [];
  })).sort((a, b) => a.due!.localeCompare(b.due!)));

  readonly remaining = computed(() => {
    const deadline = this.draft()?.deadline;
    const seconds = deadline ? Math.max(0, Math.ceil((deadline - this.now()) / 1000)) : 0;
    return Math.floor(seconds / 60).toString().padStart(2, '0') + ':' + (seconds % 60).toString().padStart(2, '0');
  });

  private readonly destroyRef = inject(DestroyRef);
  private readonly beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
  private readonly onReconnect = () => void this.checkConnection();
  private channel?: BroadcastChannel;

  async ngOnInit(): Promise<void> {
    window.addEventListener('online', this.onReconnect);
    const tick = window.setInterval(() => this.now.set(Date.now()), 1000);
    this.destroyRef.onDestroy(() => {
      clearInterval(tick);
      this.channel?.close();
      window.removeEventListener('beforeunload', this.beforeUnload);
      window.removeEventListener('online', this.onReconnect);
    });

    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('dager-habit-study');
      this.channel.onmessage = async event => {
        if (event.data === 'restore') {
          try { this.booksRestored.emit((await makeBackup(this.database())).books); }
          catch { this.error.set('No se pudo actualizar la biblioteca. Recargá la página.'); }
        }
        await this.refresh();
      };
    }
    await this.refresh();
    await this.checkConnection();
  }

  async refresh(): Promise<void> {
    try {
      this.study.set(await readStudy(this.database()));
      this.loaded.set(true);
    } catch { this.error.set('No se pudo leer el progreso. Recargá para volver a intentar.'); }
  }

  title(bookId: string): string {
    return this.books().find(book => book.id === bookId)?.title ?? 'Libro';
  }

  async start(event: Event, bookId: string, section: string, minutes: string): Promise<void> {
    event.preventDefault();
    if (!section.trim()) {
      this.error.set('Escribí el nombre de la sección.');
      return;
    }
    if (!this.books().some(book => book.id === bookId)) return;
    await this.change(study => {
      if (study.sessions.some(session => session.step !== 'done')) return;
      study.sessions.push({
        id: crypto.randomUUID(), bookId, section: section.trim(), minutes: minutes === '15' ? 15 : 10,
        step: 'scan', questions: '', questionKind: 'concepto', deadline: null, notes: '', recall: '',
        gaps: '', exam: ['', ''], closedOn: null,
      });
    });
  }

  saveDraft(session: Session, patch: Partial<Session>): void {
    void this.change(study => {
      const target = study.sessions.find(item => item.id === session.id && item.step === session.step);
      if (target) Object.assign(target, patch);
    });
  }

  async advance(event: Event, session: Session, patch: Partial<Session> = {}): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    this.error.set('');
    const candidate = { ...session, ...patch };
    if ((session.step === 'scan' && !candidate.questions.trim()) ||
        (session.step === 'recall' && !candidate.recall.trim())) {
      this.error.set('Completá el texto antes de continuar.');
      return;
    }
    if (session.step === 'exam') {
      candidate.exam = candidate.exam.map(question => question.trim()).filter(Boolean);
      if (candidate.exam.length < 2 || new Set(candidate.exam.map(question => question.toLocaleLowerCase())).size !== candidate.exam.length) {
        this.error.set('Escribí de 2 a 4 preguntas distintas.');
        return;
      }
    }
    this.saving.set(true);
    try {
      const steps = ['scan', 'read', 'recall', 'exam', 'done'] as const;
      const step = steps[steps.indexOf(session.step) + 1];
      await this.change(study => {
        const target = study.sessions.find(item => item.id === session.id && item.step === session.step);
        if (!target || !step) return;
        Object.assign(target, patch, { step });
        if (step === 'done') {
          target.exam = candidate.exam;
          target.closedOn = localDay();
        }
      });
    } finally { this.saving.set(false); }
  }

  updateExam(fields: HTMLFormElement): string[] {
    return Array.from(fields.querySelectorAll('textarea'), field => field.value);
  }

  startTimer(session: Session): void {
    if (!session.deadline) this.saveDraft(session, { deadline: Date.now() + session.minutes * 60_000 });
  }

  async answer(event: SubmitEvent, session: Session, question: number, answer: string): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    if (!answer.trim()) {
      this.error.set('Escribí tu respuesta antes de guardar.');
      return;
    }
    this.saving.set(true);
    const id = crypto.randomUUID();
    const day = localDay();
    try {
      await this.change(study => {
        const target = study.sessions.find(item => item.id === session.id);
        if (!target?.exam[question]) return;
        const { due } = reviewSchedule(target, question, study.attempts);
        if (!due || due > day) return;
        study.attempts.push({
          id, sessionId: target.id, question, day, answer: answer.trim(),
          remembered: (event.submitter as HTMLButtonElement | null)?.value === 'remembered',
        });
      });
      if (this.study().attempts.some(attempt => attempt.id === id)) {
        this.reviewing.set('');
        this.status.set('Repaso guardado.');
        (event.target as HTMLFormElement | null)?.reset();
      }
    } finally { this.saving.set(false); }
  }

  async evaluate(type: EvaluationType, session: Session, attempt?: Attempt): Promise<void> {
    const property = type === 'brain_dump' ? 'recallFeedback' : 'examFeedback';
    if (this.evaluating() || (attempt ? attempt.feedback : session[property])) return;
    const key = attempt?.id ?? session.id + type;
    this.evaluating.set(key);
    this.error.set('');
    try {
      const response = await fetch('/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Habit-Request': '1' },
        body: JSON.stringify({
          type,
          bookTitle: this.title(session.bookId),
          questions: attempt ? session.exam[attempt.question] : session.questions,
          content: attempt ? attempt.answer : type === 'exam'
            ? session.exam.join('\n') : [session.recall, session.gaps].filter(Boolean).join('\n\n'),
          reference: attempt ? [session.recall, session.notes].filter(Boolean).join('\n\n') : undefined,
        }),
      });
      if (response.status === 401) {
        this.connected.set(false);
        this.error.set('Volvé a conectar la evaluación en Ajustes.');
        return;
      }
      if (!response.ok) {
        this.error.set(response.status === 429 ? 'Se alcanzó el cupo de evaluaciones. Probá más tarde.' : 'La evaluación no está disponible. Podés reintentar después.');
        return;
      }
      const result: unknown = await response.json();
      if (!isFeedback(result)) throw new Error('Invalid feedback');
      await this.change(study => {
        if (attempt) {
          const target = study.attempts.find(item => item.id === attempt.id);
          if (!target || target.feedback) return;
          const latest = reviewSchedule(session, attempt.question, study.attempts).latest;
          target.feedback = result;
          if (latest?.id === target.id && result.scores && bonus(result) <= 3) target.repeatByAi = true;
        } else {
          const target = study.sessions.find(item => item.id === session.id);
          if (target && !target[property]) target[property] = result;
        }
      });
    } catch { this.error.set('No se pudo obtener la evaluación. Podés reintentar cuando haya conexión.'); }
    finally { this.evaluating.set(''); }
  }

  async connect(event: Event, token: HTMLInputElement): Promise<void> {
    event.preventDefault();
    if (this.authBusy()) return;
    this.authBusy.set(true);
    this.error.set('');
    try {
      const response = await fetch('/api/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Habit-Request': '1' },
        body: JSON.stringify({ token: token.value.trim() }),
      });
      if (!response.ok) {
        this.error.set(response.status === 401 ? 'El token de la app es inválido.' : 'La evaluación no está configurada en el servidor.');
        return;
      }
      token.value = '';
      this.connected.set(true);
      this.status.set('Evaluación conectada.');
    } catch { this.error.set('No se pudo conectar con la API.'); }
    finally { this.authBusy.set(false); }
  }

  async disconnect(): Promise<void> {
    try {
      const response = await fetch('/api/session', { method: 'DELETE', headers: { 'X-Habit-Request': '1' } });
      if (!response.ok) throw new Error('Could not disconnect');
      this.connected.set(false);
      this.status.set('Evaluación desconectada.');
    } catch { this.error.set('No se pudo desconectar. Volvé a intentar con conexión.'); }
  }

  async exportData(): Promise<void> {
    try {
      const backup = await makeBackup(this.database());
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'dager-habit-' + this.today() + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { this.error.set('No se pudo generar el respaldo.'); }
  }

  async selectFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    this.restoreFile.set(null);
    this.error.set('');
    input.value = '';
    if (!file) return;
    try {
      const backup = file.size <= 10 * 1024 * 1024 ? parseBackup(await file.text()) : null;
      if (backup) this.restoreFile.set({ name: file.name, backup });
      else this.error.set('El archivo no es un respaldo válido de hasta 10 MB.');
    } catch { this.error.set('No se pudo leer el archivo.'); }
  }

  async restore(): Promise<void> {
    const file = this.restoreFile();
    if (!file || this.evaluating() || this.saving()) return;
    this.saving.set(true);
    try {
      await restoreBackup(this.database(), file.backup);
      this.booksRestored.emit(file.backup.books);
      this.study.set(file.backup.study);
      this.restoreFile.set(null);
      this.channel?.postMessage('restore');
      this.error.set('');
      this.status.set('Respaldo restaurado.');
    } catch { this.error.set('No se pudo restaurar el respaldo.'); }
    finally { this.saving.set(false); }
  }

  async shareToday(): Promise<void> {
    const sessions = this.study().sessions.filter(session => session.closedOn === this.today()).length;
    const attempts = this.study().attempts.filter(attempt => attempt.day === this.today()).length;
    const text = 'Dager Habit · Hoy completé ' + sessions + ' sesiones y ' + attempts + ' repasos.';
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        this.status.set('Resumen copiado.');
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) this.error.set('No se pudo compartir el resumen.');
    }
  }

  lastAttempts(): Attempt[] {
    return this.study().attempts.slice().reverse();
  }

  sessionFor(attempt: Attempt): Session | undefined {
    return this.study().sessions.find(session => session.id === attempt.sessionId);
  }

  private async checkConnection(): Promise<void> {
    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      if (response.ok) this.connected.set((await response.json()).connected === true);
    } catch { /* Studying and self-assessment work offline. */ }
  }

  private async change(update: (current: Study) => void): Promise<void> {
    if (!this.pendingWrites()) window.addEventListener('beforeunload', this.beforeUnload);
    this.pendingWrites.update(count => count + 1);
    try {
      this.study.set(await updateStudy(this.database(), update));
      this.channel?.postMessage('study');
    } catch { this.error.set('No se pudo guardar el progreso. Volvé a intentar.'); }
    finally {
      this.pendingWrites.update(count => count - 1);
      if (!this.pendingWrites()) window.removeEventListener('beforeunload', this.beforeUnload);
    }
  }
}
