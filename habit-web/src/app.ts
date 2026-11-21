import { Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, effect, inject, signal, viewChild } from '@angular/core';
import { stagger } from 'animejs/utils';
import { waapi } from 'animejs/waapi';
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

type View = 'library' | 'today' | 'study' | 'settings' | 'book' | 'notebook' | 'about';
type CatalogMatch = Pick<Book, 'title' | 'author' | 'coverId'> & { workId: string; editionId?: string };
const routes = { library: '/', today: '/hoy', study: '/estudiar', settings: '/ajustes', notebook: '/notebook', about: '/acerca-de' };
const viewTitles = {
  library: 'Biblioteca', today: 'Hoy', study: 'Sesión de estudio', settings: 'Ajustes',
  notebook: 'Resúmenes', about: 'Acerca de',
};
const easeOut = 'cubic-bezier(0.23, 1, 0.32, 1)';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  imports: [StudyPanel],
})
export class App {
  private readonly injector = inject(Injector);
  private readonly opening = viewChild.required<ElementRef<HTMLDivElement>>('opening');
  private readonly libraryHeading = viewChild<ElementRef<HTMLDivElement>>('libraryHeading');
  private readonly heroPhoto = viewChild<ElementRef<HTMLImageElement>>('heroPhoto');
  private readonly catalogList = viewChild<ElementRef<HTMLUListElement>>('catalogList');
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private catalogRequest?: AbortController;
  readonly openingLines = [['The', 'Dager'], ['Habit']];
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
  readonly catalog = signal<CatalogMatch[]>([]);
  readonly catalogStatus = signal('');
  readonly catalogError = signal('');
  readonly searching = signal(false);
  readonly covers = coverUrl;
  readonly percent = readingPercent;

  selectStudy(target?: StudyTarget | void): void {
    const query = target?.section ? '?seccion=' + encodeURIComponent(target.section.id) : '';
    this.go(target ? routes.study + '/' + encodeURIComponent(target.bookId) + query : routes.study);
  }

  bookLink(id: string): string {
    return '#/libros/' + encodeURIComponent(id);
  }

  private go(path: string): void {
    if (location.hash !== '#' + path) history.pushState(null, '', '#' + path);
    this.readRoute(true);
  }

  private readRoute(focus = false): void {
    const previousView = this.view();
    const revisiting = history.state?.habitVisited === true;
    if (!revisiting) history.replaceState({ ...history.state, habitVisited: true }, '');
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
    if (focus) afterNextRender(() => {
      const main = document.getElementById('main-content');
      (main?.querySelector<HTMLElement>('h1:not([hidden] *)') ?? main)?.focus({ preventScroll: revisiting });
      if (!revisiting && previousView !== 'library') this.revealLibrary();
    }, { injector: this.injector });
  }

  replaceBooks(books: Book[]): void {
    this.books.set(books);
  }

  readonly sortedBooks = computed(() => [...this.books()].sort((a, b) =>
    this.collator.compare(a.title, b.title) || this.collator.compare(a.author, b.author),
  ));
  readonly error = signal('');
  readonly storageError = signal('');
  readonly status = signal('');
  readonly ready = signal(false);
  readonly saving = signal(false);
  readonly loading = signal(true);

  constructor() {
    this.readRoute();
    effect(() => {
      const view = this.view();
      const title = view === 'book'
        ? this.books().find(book => book.id === this.bookId())?.title ?? 'Ficha del libro'
        : viewTitles[view];
      document.title = title + ' · The Dager Habit';
    });
    afterNextRender(() => this.playOpening());
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
    request.onblocked = () => this.showStorageError('Cerrá las otras pestañas de The Dager Habit para abrir la biblioteca.');
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
        this.storageError.set('');
        this.loading.set(false);
        this.ready.set(true);
      };
      read.onerror = () => this.showStorageError('No se pudo leer la biblioteca. Recargá para volver a intentar.');
    };
  }

  private playOpening(): void {
    if (this.view() !== 'library' || this.reducedMotion.matches) return;

    const opening = this.opening().nativeElement;
    const letters = opening.querySelectorAll<HTMLElement>('.opening-letter');
    const listeners = new AbortController();
    const finish = () => {
      opening.hidden = true;
      listeners.abort();
    };

    opening.hidden = false;
    const reveal = waapi.animate(letters, {
      transform: ['translateY(115%)', 'translateY(0)'],
      delay: stagger(27, { ease: 'out(2)' }),
      duration: 310,
      ease: easeOut,
    });
    const exit = waapi.animate(opening, {
      opacity: [1, 0],
      delay: 690,
      duration: 210,
      ease: easeOut,
      onComplete: () => {
        finish();
        this.revealLibrary();
      },
    });

    const stop = () => {
      finish();
      reveal.cancel();
      exit.cancel();
    };
    const options = { signal: listeners.signal, capture: true, passive: true };
    window.addEventListener('keydown', stop, options);
    window.addEventListener('pointerdown', stop, options);
    window.addEventListener('focusin', stop, options);
    window.addEventListener('wheel', stop, options);
    this.reducedMotion.addEventListener('change', stop, options);
  }

  private revealLibrary(): void {
    if (this.view() !== 'library' || this.reducedMotion.matches) return;
    const heading = this.libraryHeading()?.nativeElement;
    const photo = this.heroPhoto()?.nativeElement;
    if (!heading || !photo) return;

    waapi.animate(heading, {
      opacity: [0.68, 1],
      transform: ['translateY(14px)', 'translateY(0)'],
      duration: 280,
      ease: easeOut,
    });
    waapi.animate(photo, {
      transform: ['scale(1.12)', 'scale(1)'],
      duration: 420,
      ease: easeOut,
    });
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

  async searchBooks(event: Event, input: HTMLInputElement): Promise<void> {
    event.preventDefault();
    if (this.searching()) return;
    const query = input.value.trim();
    if (query.length < 2) {
      input.setCustomValidity('Escribí al menos dos caracteres.');
      input.reportValidity();
      return;
    }
    this.catalogError.set('');
    this.catalogStatus.set('Buscando en Open Library…');
    this.catalog.set([]);
    this.searching.set(true);
    const request = new AbortController();
    this.catalogRequest = request;
    try {
      const response = await fetch('/api/catalog?q=' + encodeURIComponent(query), { signal: request.signal });
      if (!response.ok) throw new Error('Catalog unavailable');
      const matches = await response.json() as CatalogMatch[];
      if (request.signal.aborted) return;
      this.catalog.set(matches);
      if (matches.length) {
        const count = matches.length === 1 ? '1 resultado' : `${matches.length} resultados`;
        this.catalogStatus.set(`${count} para «${query}».`);
      } else {
        this.catalogStatus.set('No encontramos coincidencias. Probá con otra búsqueda o agregá el libro manualmente.');
      }
      if (matches.length && !this.reducedMotion.matches) {
        afterNextRender(() => this.revealCatalog(), { injector: this.injector });
      }
    } catch {
      if (request.signal.aborted) return;
      this.catalogStatus.set('');
      this.catalogError.set('No se pudo buscar en Open Library. Volvé a intentar o agregá el libro manualmente.');
    } finally {
      if (this.catalogRequest === request) {
        this.catalogRequest = undefined;
        this.searching.set(false);
      }
    }
  }

  catalogInputChanged(input: HTMLInputElement): void {
    input.setCustomValidity('');
    if (!input.value) this.clearCatalogSearch(input);
  }

  clearCatalogSearch(input: HTMLInputElement): void {
    this.catalogRequest?.abort();
    this.catalogRequest = undefined;
    this.searching.set(false);
    this.catalog.set([]);
    this.catalogStatus.set('');
    this.catalogError.set('');
    input.value = '';
    input.setCustomValidity('');
    input.focus();
  }

  private revealCatalog(): void {
    const list = this.catalogList()?.nativeElement;
    if (!list || this.reducedMotion.matches || this.view() !== 'library') return;

    const rows = list.querySelectorAll<HTMLLIElement>(':scope > li:nth-child(-n+4)');
    waapi.animate(rows, {
      opacity: [0.62, 1],
      transform: ['translateY(16px)', 'translateY(0)'],
      delay: stagger(32, { ease: 'out(2)' }),
      duration: 250,
      ease: easeOut,
    });
  }

  async importBook(match: CatalogMatch): Promise<void> {
    if (this.saving() || !this.ready()) return;
    this.saving.set(true);
    this.catalogError.set('');
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
      }, id => {
        if (this.view() === 'library') this.go(this.bookLink(id).slice(1));
      }, message => this.catalogError.set(message));
    } catch {
      this.saving.set(false);
      this.catalogError.set('No se pudo cargar la ficha del catálogo. Volvé a intentar o agregala manualmente.');
    }
  }

  private saveBook(book: Book, complete: (id: string) => void, reportError = (message: string) => this.error.set(message)): void {
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
      this.status.set(savedId === book.id
        ? `Agregaste «${book.title}» a la biblioteca.`
        : `«${book.title}» ya estaba en tu biblioteca.`);
      complete(savedId);
    };
    transaction.onabort = () => {
      this.saving.set(false);
      reportError('No se pudo guardar el libro. Volvé a intentar.');
    };
  }

  private showStorageError(message: string): void {
    this.storageError.set(message);
    this.loading.set(false);
    this.ready.set(false);
  }
}
