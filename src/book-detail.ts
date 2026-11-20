import { Component, computed, input, output, signal } from '@angular/core';
import {
  Book, BookSection, ReadingReminder, Session, coverUrl, editBook, maxPages, readingPercent, reminderCalendar,
} from './study-data';

export interface StudyTarget {
  bookId: string;
  section?: BookSection;
}

const reminderDate = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' });

@Component({ selector: 'app-book-detail', templateUrl: './book-detail.html' })
export class BookDetail {
  readonly book = input.required<Book>();
  readonly sessions = input.required<Session[]>();
  readonly database = input.required<IDBDatabase>();
  readonly changed = output<Book[]>();
  readonly study = output<StudyTarget>();

  readonly coverUrl = coverUrl;
  readonly maxPages = maxPages;
  readonly busy = signal(false);
  readonly error = signal('');
  readonly status = signal('');
  readonly coverFailed = signal(false);
  readonly percent = computed(() => readingPercent(this.book()));
  readonly draft = computed(() => this.sessions().find(session => session.step !== 'done'));
  readonly completed = computed(() => this.sessions().filter(session => session.step === 'done').reverse());

  formatReminder(reminder: ReadingReminder): string {
    return reminderDate.format(reminder.at);
  }

  async saveProgress(event: Event, total: HTMLInputElement, page: HTMLInputElement): Promise<void> {
    event.preventDefault();
    if (!Number.isInteger(total.valueAsNumber) || total.valueAsNumber < 1 || total.valueAsNumber > maxPages ||
        !Number.isInteger(page.valueAsNumber) || page.valueAsNumber < 0 || page.valueAsNumber > total.valueAsNumber) {
      this.error.set('Ingresá el total de páginas y un avance entre cero y ese total.');
      return;
    }
    await this.change(book => ({ ...book, totalPages: total.valueAsNumber, page: page.valueAsNumber }), 'Avance actualizado.');
  }

  async addSection(event: Event, input: HTMLInputElement, end: HTMLInputElement): Promise<void> {
    event.preventDefault();
    const title = input.value.trim();
    const endPage = end.value ? end.valueAsNumber : undefined;
    if (!title || (endPage !== undefined && (!Number.isInteger(endPage) || endPage < 1 || endPage > maxPages))) {
      this.error.set('Completá el nombre de la sección y revisá la página final.');
      return;
    }
    const section = { id: crypto.randomUUID(), title, endPage };
    const ok = await this.change(book => {
      const sections = book.sections ?? [];
      if (sections.length >= 250 || sections.some(existing => existing.title.toLocaleLowerCase() === title.toLocaleLowerCase()) ||
          (endPage !== undefined && book.totalPages !== undefined && endPage > book.totalPages)) return null;
      return { ...book, sections: [...sections, section] };
    }, 'Sección agregada.', 'Ya existe una sección con ese nombre o la página final supera el total del libro.');
    if (ok) {
      input.value = '';
      end.value = '';
      input.focus();
    }
  }

  studied(section: BookSection): boolean {
    return this.completed().some(session => session.sectionId === section.id ||
      (!session.sectionId && session.section.toLocaleLowerCase() === section.title.toLocaleLowerCase()));
  }

  async markPages(section: BookSection): Promise<void> {
    const end = section.endPage;
    if (!end) return;
    await this.change(book => !book.totalPages || end > book.totalPages
      ? null : { ...book, page: Math.max(book.page ?? 0, end) },
    'Avance actualizado.', 'Revisá el total de páginas antes de marcar esta sección.');
  }

  start(section?: BookSection): void {
    this.study.emit({ bookId: this.book().id, section });
  }

  async saveReminder(event: Event, date: HTMLInputElement, kind: string): Promise<void> {
    event.preventDefault();
    const at = new Date(date.value).getTime();
    if (!Number.isFinite(at) || at <= Date.now() || at > Date.UTC(2100, 0, 1)) {
      this.error.set('Elegí una fecha y hora futuras.');
      return;
    }

    await this.change(book => ({
      ...book, reminder: { id: book.reminder?.id ?? crypto.randomUUID(), at, kind: kind === 'study' ? 'study' : 'reading' },
    }), 'Recordatorio guardado.');
    date.value = '';
  }

  async clearReminder(): Promise<void> {
    await this.change(book => ({ ...book, reminder: undefined }), 'Recordatorio quitado de Hoy.');
  }

  downloadReminder(reminder: ReadingReminder): void {
    downloadFile(reminderCalendar(this.book(), reminder), 'recordatorio-dager-habit.ics', 'text/calendar');
  }

  private async change(edit: (book: Book) => Book | null, message: string, failure = 'No se pudo guardar el cambio.'): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    this.error.set('');
    this.status.set('');
    try {
      this.changed.emit(await editBook(this.database(), this.book().id, edit));
      this.status.set(message);
      return true;
    } catch {
      this.error.set(failure);
      return false;
    } finally { this.busy.set(false); }
  }
}

export function downloadFile(contents: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
