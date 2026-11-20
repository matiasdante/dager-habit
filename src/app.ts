import { Component, computed, signal } from '@angular/core';
import { Book } from './study-data';
import { StudyPanel } from './study';

const initialBooks: Book[] = [
  { id: 'atomic-habits', title: 'Hábitos atómicos', author: 'James Clear' },
  { id: '12-rules', title: '12 reglas para vivir', author: 'Jordan Peterson' },
  { id: 'college-success', title: 'College Success', author: 'Universidad de Massachusetts' },
  { id: 'unfair-advantage', title: 'The Unfair Advantage', author: 'Ash Ali y Hasan Kubba' },
  { id: 'mindset', title: 'Mindset', author: 'Carol Dweck' },
  { id: 'friends', title: 'Cómo ganar amigos e influir sobre las personas', author: 'Dale Carnegie' },
  { id: 'deep-work', title: 'Deep Work', author: 'Cal Newport' },
  { id: 'digital-minimalism', title: 'Minimalismo digital', author: 'Cal Newport' },
  { id: 'fooled', title: 'Fooled by Randomness', author: 'Nassim Nicholas Taleb' },
  { id: 'thinking', title: 'Thinking, Fast and Slow', author: 'Daniel Kahneman' },
];

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  imports: [StudyPanel],
})
export class App {
  private readonly books = signal<Book[]>([]);
  private readonly collator = new Intl.Collator('es-AR', { sensitivity: 'base', numeric: true });
  readonly database = signal<IDBDatabase | null>(null);
  readonly view = signal<'library' | 'today' | 'study' | 'settings'>('library');

  navigate(view: 'library' | 'today' | 'study' | 'settings'): void {
    this.view.set(view);
    requestAnimationFrame(() => {
      if (this.view() === view) document.querySelector<HTMLElement>('main:not([hidden]) h1')?.focus();
    });
  }

  replaceBooks(books: Book[]): void {
    this.books.set(books);
  }

  readonly sortedBooks = computed(() => [...this.books()].sort((a, b) =>
    this.collator.compare(a.title, b.title) || this.collator.compare(a.author, b.author),
  ));
  readonly error = signal('');
  readonly status = signal('');
  readonly ready = signal(false);
  readonly saving = signal(false);
  readonly loading = signal(true);

  constructor() {
    if (!window.indexedDB) {
      this.showStorageError('El almacenamiento está deshabilitado en este navegador.');
      return;
    }

    const request = indexedDB.open('dager-habit', 2);
    request.onupgradeneeded = event => {
      if (event.oldVersion === 0) {
        const store = request.result.createObjectStore('books', { keyPath: 'id' });
        for (const book of initialBooks) store.add(book);
      }
      request.result.createObjectStore('study');
    };
    request.onblocked = () => this.showStorageError('Cerrá las otras pestañas de Dager Habit para abrir la biblioteca.');
    request.onerror = () => this.showStorageError('No se pudo abrir la biblioteca. Revisá el almacenamiento del navegador.');
    request.onsuccess = () => {
      const database = request.result;
      this.database.set(database);
      database.onversionchange = () => {
        database.close();
        this.database.set(null);
        this.showStorageError('La biblioteca cambió en otra pestaña. Recargá para seguir.');
      };
      const read = database.transaction('books').objectStore('books').getAll();
      read.onsuccess = () => {
        this.books.set(read.result);
        this.error.set('');
        this.loading.set(false);
        this.ready.set(true);
      };
      read.onerror = () => this.showStorageError('No se pudo leer la biblioteca. Recargá para volver a intentar.');
    };
  }

  addBook(event: Event, title: HTMLInputElement, author: HTMLInputElement): void {
    event.preventDefault();
    const database = this.database();
    if (!database || !this.ready() || this.saving()) return;

    for (const field of [title, author]) {
      if (!field.value.trim()) {
        field.setCustomValidity(field === title ? 'Escribí el título.' : 'Escribí el nombre del autor.');
        field.reportValidity();
        return;
      }
    }

    this.saving.set(true);
    this.error.set('');
    this.status.set('');
    const book = { id: crypto.randomUUID(), title: title.value.trim(), author: author.value.trim() };
    const transaction = database.transaction('books', 'readwrite');
    const store = transaction.objectStore('books');
    store.add(book);
    const read = store.getAll();

    transaction.oncomplete = () => {
      this.books.set(read.result);
      this.saving.set(false);
      title.value = '';
      author.value = '';
      this.status.set(`Agregaste «${book.title}» a la biblioteca.`);
      if (document.activeElement === document.body || document.activeElement?.closest('form') === title.form) {
        title.focus();
      }
    };
    transaction.onabort = () => {
      this.saving.set(false);
      this.error.set('No se pudo guardar el libro. Volvé a intentar.');
    };
  }

  private showStorageError(message: string): void {
    this.error.set(message);
    this.loading.set(false);
    this.ready.set(false);
  }
}
