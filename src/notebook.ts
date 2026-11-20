import { Component, computed, input, signal } from '@angular/core';
import { Book, Session, readingPercent } from './study-data';
import { downloadFile } from './book-detail';

interface Notebook {
  id: string;
  title: string;
}

interface NotebookStatus {
  configured: boolean;
  appConnected: boolean;
  googleConnected: boolean;
  eligible: boolean;
  notebooks: Notebook[];
  enterpriseUrl?: string;
}

@Component({ selector: 'app-notebook', templateUrl: './notebook.html' })
export class NotebookPanel {
  readonly books = input.required<Book[]>();
  readonly sessions = input.required<Session[]>();
  readonly bookId = signal('');
  readonly google = signal<NotebookStatus | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly status = signal('');
  readonly syncedUrl = signal('');
  readonly selected = computed(() => this.books().find(book => book.id === this.bookId()) ?? this.books()[0]);
  readonly report = computed(() => {
    const book = this.selected();
    if (!book) return '';
    const sessions = this.sessions().filter(session => session.bookId === book.id);
    if (!sessions.length) return '';
    const progress = readingPercent(book);
    const lines = [book.title, book.author];
    if (progress !== null) lines.push('Avance · ' + (book.page ?? 0) + ' de ' + book.totalPages + ' páginas (' + progress + ' %)');
    for (const session of sessions) {
      lines.push('', session.section + ' · ' + session.closedOn);
      if (session.notes) lines.push('Apuntes', session.notes);
      lines.push('Volcado de memoria', session.recall);
      if (session.gaps) lines.push('Para revisar', session.gaps);
    }
    return lines.join('\n');
  });

  ngOnInit(): void {
    if (location.hash.includes('google=error')) this.error.set('Google no completó la autorización. Volvé a iniciar sesión.');
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const response = await fetch('/api/notebook/status', { cache: 'no-store' });
      if (response.ok) this.google.set(await response.json() as NotebookStatus);
    } catch { /* Local summaries and exports are still available. */ }
  }

  async connect(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      const response = await fetch('/api/notebook/connect', { method: 'POST', headers: { 'X-Habit-Request': '1' } });
      if (!response.ok) throw new Error('Google login unavailable');
      const { url } = await response.json();
      const authorization = new URL(url);
      if (authorization.origin !== 'https://accounts.google.com') throw new Error('Invalid Google sign-in');
      location.assign(authorization);
    } catch { this.error.set('No se pudo iniciar sesión con Google.'); }
    finally { this.busy.set(false); }
  }

  async disconnect(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      const response = await fetch('/api/notebook/logout', { method: 'POST', headers: { 'X-Habit-Request': '1' } });
      if (!response.ok) throw new Error('Google logout unavailable');
      this.syncedUrl.set('');
      await this.refresh();
    } catch { this.error.set('No se pudo desvincular Google.'); }
    finally { this.busy.set(false); }
  }

  download(): void {
    if (this.report()) downloadFile(this.report(), 'dager-habit-resumen.txt', 'text/plain;charset=utf-8');
  }

  async sync(event: Event, notebookId: string): Promise<void> {
    event.preventDefault();
    const google = this.google();
    const book = this.selected();
    if (!book || !google?.eligible || !google.notebooks.some(item => item.id === notebookId) || this.busy() || !this.report()) return;

    this.busy.set(true);
    this.error.set('');
    this.status.set('');
    this.syncedUrl.set('');
    try {
      const response = await fetch('/api/notebook/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Habit-Request': '1' },
        body: JSON.stringify({ notebookId, title: book.title, summary: this.report() }),
      });
      if (!response.ok) {
        this.error.set(response.status === 403 ? 'Tu cuenta necesita una licencia Enterprise y acceso de edición al notebook.'
          : response.status === 401 ? 'Volvé a iniciar sesión con Google.'
          : response.status === 400 || response.status === 413 ? 'El resumen supera el tamaño permitido. Podés descargarlo en texto.'
          : 'Google no pudo guardar el resumen. Volvé a intentar.');
        if (response.status === 401 || response.status === 403) await this.refresh();
        return;
      }
      const result = await response.json();
      const link = new URL(result.url);
      if (link.origin === 'https://notebook.cloud.google.com') this.syncedUrl.set(link.href);
      this.status.set('Resumen agregado como fuente al notebook.');
    } catch { this.error.set('No se pudo sincronizar el resumen.'); }
    finally { this.busy.set(false); }
  }
}
