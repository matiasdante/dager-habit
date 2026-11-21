import { Component, DestroyRef, Injector, afterNextRender, computed, inject, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { BookDetail, StudyTarget, downloadFile } from './book-detail';
import { NotebookPanel } from './notebook';
import {
  Attempt, Book, Feedback, Session, Study, addDays, bonus, emptyStudy, formatStudyDay, isFeedback, localDay,
  makeBackup, parseBackup, progress, readBooks, readStudy, restoreBackup, reviewSchedule, scheduledReviews,
  timerRemaining, updateStudy,
} from './study-data';

type EvaluationType = 'brain_dump' | 'exam' | 'review';
interface Provider { id: string; name: string; model: string }
const evaluationPreferences = 'dager-habit-evaluation';
const studySteps = ['scan', 'read', 'recall', 'exam', 'done'] as const;

@Component({ selector: 'app-study', templateUrl: './study.html', imports: [NgTemplateOutlet, BookDetail, NotebookPanel] })
export class StudyPanel {
  readonly formatDay = formatStudyDay;
  readonly steps = studySteps;
  readonly feedbackXp = bonus;
  readonly database = input.required<IDBDatabase>();
  readonly books = input.required<Book[]>();
  readonly booksRestored = output<Book[]>();
  readonly view = input.required<'today' | 'study' | 'settings' | 'book' | 'notebook'>();
  readonly bookId = input.required<string>();
  readonly bookSectionId = input<string>();
  readonly studyTarget = input<StudyTarget | null>(null);
  readonly openStudy = output<StudyTarget | void>();

  readonly study = signal<Study>(emptyStudy());
  readonly now = signal(Date.now());
  readonly today = computed(() => localDay(this.now()));
  readonly drafts = computed(() => this.study().sessions.filter(session => session.step !== 'done'));
  readonly draft = computed(() => {
    const target = this.studyTarget();
    return target ? this.drafts().find(session => session.bookId === target.bookId) : this.drafts()[0];
  });
  readonly currentBook = computed(() => this.books().find(book => book.id === this.bookId()));
  readonly bookSessions = computed(() => this.study().sessions.filter(session => session.bookId === this.bookId()));
  readonly completed = computed(() => this.study().sessions.filter(session => session.step === 'done').reverse());
  readonly stats = computed(() => progress(this.study(), this.today()));
  readonly reviewing = signal('');
  readonly status = signal('');
  readonly error = signal('');
  readonly loaded = signal(false);
  readonly saving = signal(false);
  readonly pendingWrites = signal(0);
  readonly evaluating = signal('');
  readonly connected = signal(false);
  readonly providers = signal<Provider[]>([]);
  readonly providerId = signal('');
  readonly model = signal('');
  readonly selectedProvider = computed(() => this.providers().find(provider => provider.id === this.providerId()));
  readonly canEvaluate = computed(() => this.connected() && !!this.selectedProvider());
  readonly authBusy = signal(false);
  readonly restoreFile = signal<{ name: string; backup: NonNullable<ReturnType<typeof parseBackup>> } | null>(null);
  private fileSelection = 0;

  private readonly schedule = computed(() => scheduledReviews(this.completed(), this.study().attempts));
  readonly due = computed(() => this.schedule().filter(item => item.due <= this.today()));
  readonly nextReviews = computed(() => {
    const today = this.today();
    const week = Array.from({ length: 7 }, (_, index) => ({ day: addDays(today, index + 1), reviews: new Map<string, {
      bookId: string; section: string; count: number;
    }>(), count: 0 }));
    const days = new Map(week.map(day => [day.day, day]));
    for (const item of this.schedule()) {
      const day = days.get(item.due);
      if (!day) continue;
      const { bookId, section } = item.session;
      const key = JSON.stringify([bookId, section]);
      const review = day.reviews.get(key) ?? { bookId, section, count: 0 };
      review.count++;
      day.count++;
      day.reviews.set(key, review);
    }
    return week;
  });
  readonly activeBooks = computed(() => this.books().filter(book => !book.archived));
  readonly reminders = computed(() => this.activeBooks().flatMap(book => book.reminder ? [{ book, reminder: book.reminder }] : [])
    .sort((a, b) => a.reminder.at - b.reminder.at));
  readonly preferredBook = computed(() => this.activeBooks().find(book => book.id === this.studyTarget()?.bookId));

  readonly remaining = computed(() => {
    const draft = this.draft();
    const seconds = draft ? Math.ceil(timerRemaining(draft, this.now()) / 1000) : 0;
    return Math.floor(seconds / 60).toString().padStart(2, '0') + ':' + (seconds % 60).toString().padStart(2, '0');
  });

  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
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
        if (event.data === 'restore' || event.data === 'books') {
          try { this.booksRestored.emit(await readBooks(this.database())); }
          catch { this.error.set('No se pudo actualizar la biblioteca. Recargá la página.'); }
        }
        if (event.data === 'study' || event.data === 'restore') await this.refresh();
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

  bookUrl(bookId: string): string {
    return '#/libros/' + encodeURIComponent(bookId);
  }

  displayDate(at: number): string {
    return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(at);
  }

  applyBookChanges(books: Book[]): void {
    this.booksRestored.emit(books);
    this.channel?.postMessage('books');
  }

  async start(event: Event, bookId: string, sectionField: HTMLInputElement, minutes: string): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    const section = sectionField.value.trim();
    if (!section) {
      sectionField.setCustomValidity('Escribí el nombre de la sección.');
      sectionField.reportValidity();
      return;
    }
    if (!this.activeBooks().some(book => book.id === bookId)) return;
    const target = this.studyTarget();
    const sectionId = target?.bookId === bookId && target.section?.title === section ? target.section.id : undefined;
    this.error.set('');
    this.status.set('');
    this.saving.set(true);
    const saved = await this.change(study => {
      if (study.sessions.some(session => session.step !== 'done' && session.bookId === bookId)) return;
      study.sessions.push({
        id: crypto.randomUUID(), bookId, section, sectionId, minutes: minutes === '15' ? 15 : 10,
        step: 'scan', questions: '', questionKind: 'concepto', deadline: null, notes: '', recall: '',
        gaps: '', exam: ['', ''], closedOn: null,
      });
    });
    this.saving.set(false);
    if (saved) this.focusAfterRender('step-heading');
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
      this.showInvalidField(event, session.step === 'scan' ? '#scan-questions' : '#recall-text', 'Completá el texto antes de continuar.');
      return;
    }
    if (session.step === 'exam') {
      const seen = new Set<string>();
      for (const [index, text] of candidate.exam.entries()) {
        const question = text.trim().toLocaleLowerCase();
        if (!question && index >= 2) continue;
        if (!question || seen.has(question)) {
          this.showInvalidField(event, '#exam-' + index, question ? 'Escribí una pregunta distinta.' : 'Completá esta pregunta.');
          return;
        }
        seen.add(question);
      }
      candidate.exam = candidate.exam.map(question => question.trim()).filter(Boolean);
    }
    this.saving.set(true);
    try {
      const step = studySteps[studySteps.indexOf(session.step) + 1];
      const saved = await this.change(study => {
        const target = study.sessions.find(item => item.id === session.id && item.step === session.step);
        if (!target || !step) return;
        Object.assign(target, patch, { step });
        delete target.pausedRemainingMs;
        if (step === 'done') {
          target.exam = candidate.exam;
          target.closedOn = localDay();
        }
      });
      if (saved) {
        if (step === 'done') this.status.set('Sesión completada. Encontrá las preguntas en Hoy cuando toque repasarlas.');
        this.focusAfterRender(step === 'done'
          ? (this.draft() ? 'step-heading' : 'completed-heading')
          : 'step-heading');
      }
    } finally { this.saving.set(false); }
  }

  updateExam(fields: HTMLFormElement): string[] {
    return Array.from(fields.querySelectorAll('textarea'), field => field.value);
  }

  saveExam(session: Session, form: HTMLFormElement): void {
    for (const field of form.querySelectorAll('textarea')) field.setCustomValidity('');
    this.saveDraft(session, { exam: this.updateExam(form) });
  }

  async addQuestion(session: Session, form: HTMLFormElement): Promise<void> {
    const fields = this.updateExam(form);
    if (fields.length >= 4 || this.saving()) return;
    const saved = await this.change(study => {
      const target = study.sessions.find(item => item.id === session.id && item.step === 'exam');
      if (target) target.exam = [...fields, ''];
    });
    if (saved) this.focusAfterRender('exam-' + fields.length);
  }

  async discardSession(session: Session, dialog: HTMLDialogElement): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    const saved = await this.change(study => {
      study.sessions = study.sessions.filter(item => item.id !== session.id || item.step === 'done');
    });
    this.saving.set(false);
    dialog.close();
    if (saved) {
      this.status.set('Borrador descartado.');
      this.focusAfterRender(this.draft() ? 'step-heading' : 'new-session-heading');
    }
  }

  async startTimer(session: Session): Promise<void> {
    if (session.deadline || this.saving()) return;
    const saved = await this.change(study => {
      const target = study.sessions.find(item => item.id === session.id && item.step === 'read');
      if (!target || target.deadline !== null) return;
      target.deadline = Date.now() + (target.pausedRemainingMs ?? target.minutes * 60_000);
      delete target.pausedRemainingMs;
    });
    if (saved) this.focusAfterRender('study-timer');
  }

  async pauseTimer(session: Session): Promise<void> {
    if (!session.deadline || this.saving()) return;
    const saved = await this.change(study => {
      const target = study.sessions.find(item => item.id === session.id && item.step === 'read');
      if (!target?.deadline) return;
      const remaining = timerRemaining(target, Date.now());
      if (remaining <= 0) return;
      target.pausedRemainingMs = Math.min(remaining, target.minutes * 60_000);
      target.deadline = null;
    });
    if (saved) this.focusAfterRender('study-timer');
  }

  focusPendingReviews(): void {
    const heading = document.getElementById('reviews-heading');
    const first = heading?.parentElement?.querySelector('article');
    (first?.querySelector<HTMLElement>('textarea') ?? first?.querySelector('button') ?? heading)?.focus();
  }

  openReview(key: string): void {
    this.reviewing.set(key);
    this.error.set('');
    this.focusAfterRender('review-answer');
  }

  reviewDraft(sessionId: string, question: number): string {
    return this.study().reviewDrafts?.find(draft => draft.sessionId === sessionId && draft.question === question)?.answer ?? '';
  }

  saveReviewDraft(sessionId: string, question: number, answer: string): void {
    void this.change(study => {
      const session = study.sessions.find(item => item.id === sessionId);
      if (!session?.exam[question]) return;
      const { due } = reviewSchedule(session, question, study.attempts);
      if (!due || due > localDay()) return;
      const otherDrafts = study.reviewDrafts?.filter(draft => draft.sessionId !== sessionId || draft.question !== question) ?? [];
      study.reviewDrafts = answer.trim() ? [...otherDrafts, { sessionId, question, answer }] : otherDrafts;
    });
  }

  async answer(event: SubmitEvent, session: Session, question: number, answer: string): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    if (!answer.trim()) {
      this.showInvalidField(event, '#review-answer', 'Escribí tu respuesta antes de guardar.');
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
        if (study.reviewDrafts)
          study.reviewDrafts = study.reviewDrafts.filter(draft => draft.sessionId !== session.id || draft.question !== question);
      });
      if (this.study().attempts.some(attempt => attempt.id === id)) {
        this.reviewing.set('');
        this.status.set('Repaso guardado.');
        this.focusAfterRender('reviews-heading');
      }
    } finally { this.saving.set(false); }
  }

  async evaluate(type: EvaluationType, session: Session, attempt?: Attempt): Promise<void> {
    const property = type === 'brain_dump' ? 'recallFeedback' : 'examFeedback';
    const provider = this.selectedProvider();
    if (!this.connected() || !provider || this.evaluating() || (attempt ? attempt.feedback : session[property])) return;
    const key = attempt?.id ?? session.id + type;
    this.evaluating.set(key);
    this.error.set('');
    try {
      const response = await fetch('/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Habit-Request': '1' },
        body: JSON.stringify({
          type,
          provider: provider.id,
          model: this.model() || undefined,
          bookTitle: this.title(session.bookId),
          questions: attempt ? session.exam[attempt.question] : session.questions,
          content: attempt ? attempt.answer : type === 'exam'
            ? session.exam.join('\n') : [session.recall, session.gaps].filter(Boolean).join('\n\n'),
          reference: attempt ? [session.recall, session.notes].filter(Boolean).join('\n\n') : undefined,
        }),
      });
      if (response.status === 401) {
        this.connected.set(false);
        this.error.set('Volvé a conectar la app en Ajustes.');
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
      await this.loadProviders();
    } catch { this.error.set('No se pudo conectar con la API.'); }
    finally { this.authBusy.set(false); }
  }

  async disconnect(): Promise<void> {
    try {
      const response = await fetch('/api/session', { method: 'DELETE', headers: { 'X-Habit-Request': '1' } });
      if (!response.ok) throw new Error('Could not disconnect');
      this.connected.set(false);
      this.providers.set([]);
      this.status.set('Evaluación desconectada.');
    } catch { this.error.set('No se pudo desconectar. Volvé a intentar con conexión.'); }
  }

  async exportData(): Promise<void> {
    try {
      const backup = await makeBackup(this.database());
      downloadFile(JSON.stringify(backup), 'dager-habit-' + this.today() + '.json', 'application/json');
    } catch { this.error.set('No se pudo generar el respaldo.'); }
  }

  async selectFile(input: HTMLInputElement): Promise<void> {
    const selection = ++this.fileSelection;
    const file = input.files?.[0];
    this.restoreFile.set(null);
    this.error.set('');
    input.value = '';
    if (!file) return;
    try {
      const content = await file.text();
      if (selection !== this.fileSelection) return;
      const backup = parseBackup(content);
      if (backup) {
        this.restoreFile.set({ name: file.name, backup });
        this.focusAfterRender('restore-heading');
      } else {
        this.error.set('El archivo no es un respaldo válido de The Dager Habit.');
        this.focusAfterRender('study-error');
      }
    } catch {
      if (selection === this.fileSelection) this.error.set('No se pudo leer el archivo.');
    }
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
      this.focusAfterRender('backup-file');
    } catch { this.error.set('No se pudo restaurar el respaldo.'); }
    finally { this.saving.set(false); }
  }

  async shareToday(): Promise<void> {
    const sessions = this.study().sessions.filter(session => session.closedOn === this.today()).length;
    const attempts = this.study().attempts.filter(attempt => attempt.day === this.today()).length;
    const text = 'The Dager Habit · Hoy completé ' + sessions + ' sesiones y ' + attempts + ' repasos.';
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
      if (response.ok) {
        this.connected.set((await response.json()).connected === true);
        if (this.connected()) await this.loadProviders();
      }
    } catch { /* Studying and self-assessment work offline. */ }
  }

  saveProvider(event: Event, id: string, model: string): void {
    event.preventDefault();
    this.error.set('');
    if (!this.providers().some(provider => provider.id === id) ||
        (model.trim() && !/^[a-zA-Z0-9][a-zA-Z0-9._:/+@~-]{0,149}$/.test(model.trim()))) {
      this.error.set('Ingresá un identificador de modelo válido.');
      return;
    }
    this.providerId.set(id);
    this.model.set(model.trim());
    try { localStorage.setItem(evaluationPreferences, JSON.stringify({ id, model: this.model() })); }
    catch { this.error.set('La selección se aplica hasta que cierres la app.'); }
    this.status.set('Proveedor actualizado.');
  }

  private async loadProviders(): Promise<void> {
    const response = await fetch('/api/evaluation-providers', { cache: 'no-store' });
    if (!response.ok) return;
    const { providers, defaultProvider } = await response.json() as { providers: Provider[]; defaultProvider: string };
    this.providers.set(providers);
    let saved: { id?: string; model?: string } | null = null;
    try { saved = JSON.parse(localStorage.getItem(evaluationPreferences) ?? 'null'); } catch { /* Optional browser preferences. */ }
    const preferred = providers.find(provider => provider.id === saved?.id);
    this.providerId.set(preferred?.id ?? providers.find(provider => provider.id === defaultProvider)?.id ?? providers[0]?.id ?? '');
    this.model.set(preferred && typeof saved?.model === 'string' ? saved.model : '');
  }

  private showInvalidField(event: Event, selector: string, text: string): void {
    const field = (event.target as HTMLFormElement).querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    field?.setCustomValidity(text);
    field?.reportValidity();
  }

  private focusAfterRender(id: string): void {
    const view = this.view();
    afterNextRender(() => {
      const target = document.getElementById(id);
      if (view === this.view() && !target?.closest('[hidden]')) target?.focus();
    }, { injector: this.injector });
  }

  private async change(update: (current: Study) => void): Promise<boolean> {
    if (!this.pendingWrites()) window.addEventListener('beforeunload', this.beforeUnload);
    this.pendingWrites.update(count => count + 1);
    try {
      this.study.set(await updateStudy(this.database(), update));
      this.channel?.postMessage('study');
      return true;
    } catch {
      this.error.set('No se pudo guardar el progreso. Volvé a intentar.');
      return false;
    }
    finally {
      this.pendingWrites.update(count => count - 1);
      if (!this.pendingWrites()) window.removeEventListener('beforeunload', this.beforeUnload);
    }
  }
}
