import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Book, coverUrl, readingPercent } from './study-data';
import { StudyTarget } from './book-detail';
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

type View = 'library' | 'today' | 'study' | 'settings' | 'book' | 'notebook';
type CatalogMatch = Pick<Book, 'title' | 'author' | 'coverId'> & { workId: string; editionId?: string };
const routes = { library: '/', today: '/hoy', study: '/estudiar', settings: '/ajustes', notebook: '/notebook' };

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  imports: [StudyPanel],
})
export class App {
  private readonly books = signal<Book[]>([]);
  private readonly collator = new Intl.Collator('es-AR', { sensitivity: 'base', numeric: true });
  readonly database = signal<IDBDatabase | null>(null);
  readonly view = signal<View>('library');
  readonly bookId = signal('');
  private readonly studyRoute = signal<{ bookId: string; sectionId?: string } | null>(null);
  readonly studyTarget = computed<StudyTarget | null>(() => {
    const target = this.studyRoute();
    const book = target && this.books().find(item => item.id === target.bookId);
    return book ? { bookId: book.id, section: book.sections?.find(section => section.id === target?.sectionId) } : null;
  });
  readonly catalog = signal<CatalogMatch[] | null>(null);
  readonly searching = signal(false);
  readonly covers = coverUrl;
  readonly percent = readingPercent;

  navigate(view: keyof typeof routes): void {
    this.go(routes[view]);
  }

  selectStudy(target?: StudyTarget | void): void {
    const query = target?.section ? '?seccion=' + encodeURIComponent(target.section.id) : '';
    this.go(target ? routes.study + '/' + encodeURIComponent(target.bookId) + query : routes.study);
  }

  bookLink(id: string): string {
    return '#/libros/' + encodeURIComponent(id);
  }

  skip(event: Event): void {
    event.preventDefault();
    const id = this.view() === 'library' ? 'library-title' : this.view() + '-heading';
    document.getElementById(id)?.focus();
  }

  private go(path: string): void {
    if (location.hash !== '#' + path) history.pushState(null, '', '#' + path);
    this.readRoute(true);
  }

  private readRoute(focus = false): void {
    const [pathname, query] = location.hash.slice(1).split('?');
    const path = pathname || '/';
    const book = path.match(/^\/libros\/([^/]+)$/);
    const study = path.match(/^\/estudiar\/([^/]+)$/);
    this.studyRoute.set(null);
    if (book) {
      try { this.bookId.set(decodeURIComponent(book[1])); }
      catch { this.bookId.set(''); }
      this.view.set('book');
    } else if (study) {
      try {
        this.studyRoute.set({ bookId: decodeURIComponent(study[1]),
          sectionId: new URLSearchParams(query).get('seccion') ?? undefined });
      } catch { this.studyRoute.set(null); }
      this.view.set('study');
    } else {
      this.view.set((Object.keys(routes) as (keyof typeof routes)[]).find(route => routes[route] === path) ?? 'library');
    }
    if (focus) requestAnimationFrame(() => document.querySelector<HTMLElement>('main:not([hidden]) h1')?.focus());
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
    this.readRoute();
    const routeListener = () => this.readRoute(true);
    window.addEventListener('hashchange', routeListener);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('hashchange', routeListener));
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

    const book = { id: crypto.randomUUID(), title: title.value.trim(), author: author.value.trim() };
    this.saveBook(book, () => {
      title.value = '';
      author.value = '';
      if (document.activeElement === document.body || document.activeElement?.closest('form') === title.form) title.focus();
    });
  }

  async searchBooks(event: Event, query: string): Promise<void> {
    event.preventDefault();
    if (this.searching() || !query.trim()) return;
    this.error.set('');
    this.catalog.set(null);
    this.searching.set(true);
    try {
      const response = await fetch('/api/catalog?q=' + encodeURIComponent(query.trim()));
      if (!response.ok) throw new Error('Catalog unavailable');
      this.catalog.set(await response.json() as CatalogMatch[]);
    } catch { this.error.set('No se pudo buscar en Open Library. Podés agregar el libro manualmente.'); }
    finally { this.searching.set(false); }
  }

  async importBook(match: CatalogMatch): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    try {
      const parameters = new URLSearchParams({ work: match.workId });
      if (match.editionId) parameters.set('edition', match.editionId);
      const response = await fetch('/api/catalog/book?' + parameters);
      if (!response.ok) throw new Error('Edition unavailable');
      const detail = await response.json() as Pick<Book, 'summary' | 'coverId' | 'totalPages'>;
      const catalogId = match.editionId ?? match.workId;
      this.saveBook({
        id: crypto.randomUUID(), catalogId, title: match.title, author: match.author,
        summary: detail.summary ?? undefined, totalPages: detail.totalPages ?? undefined,
        coverId: detail.coverId ?? match.coverId ?? undefined,
      }, id => this.go(this.bookLink(id).slice(1)));
    } catch {
      this.saving.set(false);
      this.error.set('No se pudo cargar la ficha del catálogo. Volvé a intentar o agregala manualmente.');
    }
  }

  private saveBook(book: Book, complete: (id: string) => void): void {
    const database = this.database();
    if (!database) {
      this.saving.set(false);
      return;
    }
    this.saving.set(true);
    this.error.set('');
    this.status.set('');
    const transaction = database.transaction('books', 'readwrite');
    const store = transaction.objectStore('books');
    const existing = store.getAll();
    let read: IDBRequest<Book[]>;
    let savedId = book.id;
    existing.onsuccess = () => {
      const all = existing.result as Book[];
      const imported = book.catalogId && all.find(item => item.catalogId === book.catalogId);
      const local = book.catalogId && all.find(item => !item.catalogId &&
        this.collator.compare(item.title, book.title) === 0 && this.collator.compare(item.author, book.author) === 0);
      if (imported) {
        savedId = imported.id;
        read = existing;
      } else {
        if (local) {
          savedId = local.id;
          store.put({ ...local, catalogId: book.catalogId, summary: book.summary,
            coverId: book.coverId, totalPages: local.totalPages ?? book.totalPages });
        } else store.add(book);
        read = store.getAll();
      }
    };

    transaction.oncomplete = () => {
      this.books.set(read.result);
      this.saving.set(false);
      this.status.set(`Agregaste «${book.title}» a la biblioteca.`);
      complete(savedId);
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
