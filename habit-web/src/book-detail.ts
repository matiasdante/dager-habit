import { Component, Injector, afterNextRender, computed, effect, inject, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import {
  Book, BookSection, ReadingReminder, Session, coverUrl, editBook, formatStudyDay, languageName, maxPages, readingPercent,
  reminderCalendar, updateReadingPage,
} from './study-data';

export interface StudyTarget {
  bookId: string;
  section?: BookSection;
}

const reminderDate = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' });

type BookArea = 'sections' | 'progress' | 'reminder' | 'details';

@Component({ selector: 'app-book-detail', templateUrl: './book-detail.html', imports: [NgTemplateOutlet] })
export class BookDetail {
  readonly book = input.required<Book>();
  readonly sessions = input.required<Session[]>();
  readonly sectionId = input<string>();
  readonly database = input.required<IDBDatabase>();
  readonly changed = output<Book[]>();
  readonly study = output<StudyTarget>();

  readonly coverUrl = coverUrl;
  readonly maxPages = maxPages;
  readonly languageName = languageName;
  readonly languages = computed(() => {
    const supported = ['spa', 'eng', 'por', 'fra', 'ita', 'deu'];
    const custom = this.book().language;
    return custom && !supported.includes(custom) ? [...supported, custom] : supported;
  });
  readonly busy = signal(false);
  readonly message = signal<{ area: BookArea; text: string; error?: boolean } | null>(null);
  readonly formatDay = formatStudyDay;
  readonly coverFailed = signal(false);
  readonly percent = computed(() => readingPercent(this.book()));
  readonly draft = computed(() => this.sessions().find(session => session.step !== 'done'));
  readonly completed = computed(() => this.sessions().filter(session => session.step === 'done').reverse());

  constructor() {
    const injector = inject(Injector);
    effect(() => {
      const id = this.sectionId();
      if (!id) return;
      afterNextRender(() => {
        if (id !== this.sectionId()) return;
        const heading = document.getElementById('book-section-' + id);
        if (heading && !heading.closest('[hidden]')) heading.focus();
      }, { injector });
    });
  }

  async saveDetails(event: Event, title: HTMLInputElement, author: HTMLInputElement, year: HTMLInputElement,
    language: HTMLSelectElement): Promise<void> {
    event.preventDefault();
    for (const field of [title, author]) {
      if (!field.value.trim()) {
        field.setCustomValidity(field === title ? 'Escribí el título.' : 'Escribí el nombre del autor.');
        field.reportValidity();
        return;
      }
    }
    await this.change('details', book => ({
      ...book, title: title.value.trim(), author: author.value.trim(),
      publicationYear: year.value ? year.valueAsNumber : undefined, language: language.value || undefined,
    }), 'Ficha actualizada.');
  }

  async setArchived(archived: boolean): Promise<void> {
    await this.change('details', book => ({ ...book, archived }),
      archived ? 'Libro archivado. Podés recuperarlo desde la colección.' : 'Libro devuelto a la colección.');
  }

  formatReminder(reminder: ReadingReminder): string {
    return reminderDate.format(reminder.at);
  }

  async saveProgress(event: Event, total: HTMLInputElement, page: HTMLInputElement): Promise<void> {
    event.preventDefault();
    const totalPages = total.valueAsNumber;
    const currentPage = page.valueAsNumber;
    if (!total.reportValidity() || !page.reportValidity()) return;
    if (currentPage > totalPages) {
      page.setCustomValidity('Las páginas leídas no pueden superar el total.');
      page.reportValidity();
      return;
    }
    await this.change('progress', book => updateReadingPage(book, currentPage, totalPages), 'Avance actualizado.');
  }

  async addSection(event: Event, input: HTMLInputElement, end: HTMLInputElement): Promise<void> {
    event.preventDefault();
    const title = input.value.trim();
    const endPage = end.value ? end.valueAsNumber : undefined;
    if (!title) {
      input.setCustomValidity('Escribí el nombre de la sección.');
      input.reportValidity();
      return;
    }
    const section = { id: crypto.randomUUID(), title, endPage };
    const ok = await this.change('sections', book => {
      const sections = book.sections ?? [];
      if (sections.length >= 250 || sections.some(existing => existing.title.toLocaleLowerCase() === title.toLocaleLowerCase()) ||
          (endPage !== undefined && book.totalPages !== undefined && endPage > book.totalPages)) return null;
      return { ...book, sections: [...sections, section] };
    }, 'Sección agregada.', 'Revisá que el nombre sea único, que la página final no supere el total y que haya menos de 250 secciones.');
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

  async markPages(section: BookSection, heading: HTMLElement): Promise<void> {
    const end = section.endPage;
    if (!end) return;
    const ok = await this.change('sections', book => updateReadingPage(book, Math.max(book.page ?? 0, end)),
    'Avance actualizado hasta la página ' + end + '.', 'No se pudo actualizar el avance. Revisá el total de páginas y volvé a intentar.');
    if (ok) heading.focus();
  }

  start(section?: BookSection): void {
    this.study.emit({ bookId: this.book().id, section });
  }

  async saveReminder(event: Event, date: HTMLInputElement, kind: string): Promise<void> {
    event.preventDefault();
    const at = new Date(date.value).getTime();
    if (!Number.isFinite(at) || at <= Date.now() || at > Date.UTC(2100, 0, 1)) {
      date.setCustomValidity('Elegí una fecha y hora futuras, anteriores a 2100.');
      date.reportValidity();
      return;
    }

    const ok = await this.change('reminder', book => ({
      ...book, reminder: { id: book.reminder?.id ?? crypto.randomUUID(), at, kind: kind === 'study' ? 'study' : 'reading' },
    }), 'Recordatorio guardado.');
    if (ok) date.value = '';
  }

  async clearReminder(date: HTMLInputElement): Promise<void> {
    if (await this.change('reminder', book => ({ ...book, reminder: undefined }), 'Recordatorio quitado de Hoy.')) date.focus();
  }

  downloadReminder(reminder: ReadingReminder): void {
    downloadFile(reminderCalendar(this.book(), reminder), 'recordatorio-dager-habit.ics', 'text/calendar');
  }

  private async change(area: BookArea, edit: (book: Book) => Book | null, message: string,
    failure = 'No se pudo guardar el cambio. Volvé a intentar.'): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    this.message.set(null);
    try {
      this.changed.emit(await editBook(this.database(), this.book().id, edit));
      this.message.set({ area, text: message });
      return true;
    } catch {
      this.message.set({ area, text: failure, error: true });
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
