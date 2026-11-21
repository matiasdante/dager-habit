import { Component, DestroyRef, ElementRef, Injector, afterNextRender, computed, effect, inject, signal, viewChild } from '@angular/core';
import { stagger } from 'animejs/utils';
import { waapi } from 'animejs/waapi';
import {
  Book, BookSection, coverUrl, editBook, languageName, libraryMatches, nextReadingSection, readingPercent,
  updateReadingPage, upgradeLibrary,
} from './study-data';
import { StudyTarget } from './book-detail';
import { easeOut, enter, reducedMotion, slideIn } from './motion';
import { StudyPanel } from './study';

type View = 'library' | 'today' | 'study' | 'settings' | 'book' | 'notebook' | 'about';
type CatalogMatch = Pick<Book, 'title' | 'author' | 'coverId'> & { workId: string; editionId?: string };
type CatalogEdition = Pick<Book, 'id' | 'title'> & {
  language: string | null; publicationYear: number | null; totalPages: number | null;
};
interface CatalogEditions { editions: CatalogEdition[]; nextOffset: number | null }
const routes = { library: '/', today: '/hoy', study: '/estudiar', settings: '/ajustes', notebook: '/notebook', about: '/acerca-de' };
const viewTitles = {
  library: 'Biblioteca', today: 'Hoy', study: 'Sesión de estudio', settings: 'Ajustes',
  notebook: 'Resúmenes', about: 'Acerca de',
};

const rowEntry = {
  opacity: [0.62, 1],
  transform: ['translateY(16px)', 'translateY(0)'],
  duration: 250,
};

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  imports: [StudyPanel],
})
export class App {
  private readonly injector = inject(Injector);
  private readonly opening = viewChild.required<ElementRef<HTMLDivElement>>('opening');
  private readonly bookList = viewChild<ElementRef<HTMLUListElement>>('bookList');
  private readonly catalogList = viewChild<ElementRef<HTMLUListElement>>('catalogList');
  private readonly studyPanel = viewChild(StudyPanel);
  private pendingCollectionEntry = false;
  private catalogRequest?: AbortController;
  private editionRequest?: AbortController;
  private lastOpened = '';
  private readonly books = signal<Book[]>([]);
  private readonly collator = new Intl.Collator('es-AR', { sensitivity: 'base', numeric: true });
  readonly database = signal<IDBDatabase | null>(null);
  readonly view = signal<View>('library');
  readonly bookId = signal('');
  readonly bookSectionId = signal<string | undefined>(undefined);
  private readonly studyRoute = signal<{ bookId: string; sectionId?: string } | null>(null);
  readonly studyTarget = computed<StudyTarget | null>(() => {
    const target = this.studyRoute();
    const book = target && this.books().find(item => item.id === target.bookId);
    return book ? { bookId: book.id, section: book.sections?.find(section => section.id === target?.sectionId) } : null;
  });
  readonly catalog = signal<CatalogMatch[]>([]);
  readonly catalogQuery = signal('');
  readonly catalogStatus = signal('');
  readonly catalogError = signal('');
  readonly searching = signal(false);
  readonly archived = signal(false);
  readonly editionPicker = signal<{ match: CatalogMatch; editions: CatalogEdition[]; nextOffset: number | null } | null>(null);
  readonly loadingEditions = signal(false);
  readonly collectionStatus = signal('');
  readonly collectionError = signal('');
  readonly covers = coverUrl;
  readonly percent = readingPercent;
  readonly languageName = languageName;
  readonly nextReadingSection = nextReadingSection;

  selectStudy(target?: StudyTarget | void): void {
    const query = target?.section ? '?seccion=' + encodeURIComponent(target.section.id) : '';
    this.go(target ? routes.study + '/' + encodeURIComponent(target.bookId) + query : routes.study);
  }

  bookLink(id: string, sectionId?: string): string {
    return '#/libros/' + encodeURIComponent(id) + (sectionId ? '?seccion=' + encodeURIComponent(sectionId) : '');
  }

  private go(path: string): void {
    if (location.hash !== '#' + path) history.pushState(null, '', '#' + path);
    this.readRoute(true);
  }

  private readRoute(focus = false): void {
    const revisiting = history.state?.habitVisited === true;
    if (!revisiting) history.replaceState({ ...history.state, habitVisited: true }, '');
    const hash = location.hash;
    const [pathname, query] = hash.slice(1).split('?');
    const path = pathname || '/';
    const book = path.match(/^\/libros\/([^/]+)$/);
    const study = path.match(/^\/estudiar\/([^/]+)$/);
    this.studyRoute.set(null);
    this.bookSectionId.set(undefined);
    if (book) {
      try { this.bookId.set(decodeURIComponent(book[1])); }
      catch { this.bookId.set(''); }
      this.bookSectionId.set(new URLSearchParams(query).get('seccion') ?? undefined);
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
    const view = this.view();
    this.pendingCollectionEntry = !revisiting && view === 'library';
    if (!focus && (revisiting || view === 'library')) return;
    afterNextRender(() => {
      if (location.hash !== hash) return;
      const main = document.getElementById('main-content');
      const visibleView = main?.querySelector(':scope > :not([hidden])');
      const heading = visibleView?.querySelector<HTMLElement>('h1:not([hidden] *)');
      const sectionId = this.bookSectionId();
      const chapter = view === 'book' && sectionId && this.books().find(book => book.id === this.bookId())
        ?.sections?.some(section => section.id === sectionId);
      if (focus && !chapter) (heading ?? main)?.focus({ preventScroll: revisiting });
      if (revisiting) return;
      if (view === 'library') {
        this.revealCollection();
      } else if (visibleView && heading) {
        const header = heading.closest<HTMLElement>('header, .book-masthead') ?? heading;
        const cards = visibleView.querySelectorAll<HTMLElement>('.study-card:not(dialog, [hidden], [hidden] *)');
        enter([header, ...Array.from(cards).slice(0, 3)], { ...slideIn, delay: stagger(30) });
      }
    }, { injector: this.injector });
  }

  replaceBooks(books: Book[]): void {
    this.books.set(books);
  }

  readonly sortedBooks = computed(() => [...this.books()].sort((a, b) =>
    this.collator.compare(a.title, b.title) || this.collator.compare(a.author, b.author),
  ));
  readonly collection = computed(() => this.sortedBooks().filter(book => !!book.archived === this.archived()));
  readonly archivedCount = computed(() => this.books().filter(book => book.archived).length);
  readonly localMatches = computed(() => libraryMatches(this.collection(), this.catalogQuery()));
  readonly recentBooks = computed(() => this.collection().filter(book => book.openedAt !== undefined)
    .sort((a, b) => b.openedAt! - a.openedAt!).slice(0, 4));
  readonly catalogBooks = computed(() => new Map(this.books().filter(book => book.catalogId).map(book => [book.catalogId, book])));
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
    effect(() => {
      const id = this.view() === 'book' ? this.bookId() : '';
      if (!id) this.lastOpened = '';
      const database = this.database();
      if (!database || this.lastOpened === id || !this.books().some(book => book.id === id)) return;
      this.lastOpened = id;
      void editBook(database, id, book => ({ ...book, openedAt: Date.now() }))
        .then(books => this.publishBooks(books))
        .catch(() => { /* La ficha sigue disponible aunque no se actualicen los recientes. */ });
    });
    afterNextRender(() => this.playOpening());
    const routeListener = () => this.readRoute(true);
    window.addEventListener('hashchange', routeListener);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('hashchange', routeListener));
    if (!window.indexedDB) {
      this.showStorageError('El almacenamiento está deshabilitado en este navegador.');
      return;
    }

    const request = indexedDB.open('dager-habit', 3);
    request.onupgradeneeded = event => upgradeLibrary(request.result, request.transaction!, event.oldVersion);
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
        if (this.pendingCollectionEntry) {
          afterNextRender(() => this.revealCollection(), { injector: this.injector });
        }
      };
      read.onerror = () => this.showStorageError('No se pudo leer la biblioteca. Recargá para volver a intentar.');
    };
  }

  private playOpening(): void {
    if (this.view() !== 'library' || reducedMotion.matches) return;

    const opening = this.opening().nativeElement;
    const listeners = new AbortController();
    const finish = () => {
      opening.hidden = true;
      listeners.abort();
    };

    opening.hidden = false;
    const exit = waapi.animate(opening, {
      opacity: [1, 0],
      delay: 690,
      duration: 210,
      ease: easeOut,
      onComplete: () => {
        finish();
        this.revealCollection();
      },
    });

    const stop = () => {
      finish();
      exit.cancel();
      this.revealCollection();
    };
    const options = { signal: listeners.signal, capture: true, passive: true };
    window.addEventListener('keydown', stop, options);
    window.addEventListener('pointerdown', stop, options);
    window.addEventListener('focusin', stop, options);
    window.addEventListener('wheel', stop, options);
    reducedMotion.addEventListener('change', stop, options);
  }

  private revealCollection(): void {
    if (!this.pendingCollectionEntry || !this.opening().nativeElement.hidden) return;
    const rows = this.bookList()?.nativeElement.querySelectorAll<HTMLLIElement>(':scope > li:nth-child(-n+6)');
    if (!rows?.length) return;

    this.pendingCollectionEntry = false;
    enter(rows, { ...rowEntry, delay: stagger(32, { ease: 'out(2)' }) });
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
      if (matches.length && !reducedMotion.matches) {
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
    this.catalogQuery.set(input.value);
    this.resetCatalog();
  }

  clearCatalogSearch(input: HTMLInputElement): void {
    input.value = '';
    this.catalogInputChanged(input);
    input.focus();
  }

  openSearchMatch(event: Event, input: HTMLInputElement): void {
    if ((event as KeyboardEvent).isComposing) return;
    event.preventDefault();
    const match = this.localMatches()[0] ?? (!input.value.trim() && this.recentBooks()[0]
      ? { book: this.recentBooks()[0], section: undefined } : undefined);
    if (match) this.go(this.bookLink(match.book.id, match.section?.id).slice(1));
  }

  hasStudyDraft(bookId: string): boolean {
    return this.studyPanel()?.drafts().some(draft => draft.bookId === bookId) ?? false;
  }

  private resetCatalog(): void {
    this.catalogRequest?.abort();
    this.catalogRequest = undefined;
    this.searching.set(false);
    this.catalog.set([]);
    this.catalogStatus.set('');
    this.catalogError.set('');
    this.closeEditions();
  }

  private revealCatalog(): void {
    const list = this.catalogList()?.nativeElement;
    if (!list || this.view() !== 'library') return;

    const rows = list.querySelectorAll<HTMLLIElement>(':scope > li:nth-child(-n+4)');
    enter(rows, { ...rowEntry, delay: stagger(32, { ease: 'out(2)' }) });
  }

  async chooseEditions(match: CatalogMatch, offset = 0): Promise<void> {
    this.editionRequest?.abort();
    const request = new AbortController();
    this.editionRequest = request;
    this.loadingEditions.set(true);
    this.catalogError.set('');
    const previous = offset ? this.editionPicker()?.editions ?? [] : [];
    if (!offset) {
      this.editionPicker.set({ match, editions: [], nextOffset: null });
      afterNextRender(() => document.getElementById('editions-heading')?.focus(), { injector: this.injector });
    }
    try {
      const parameters = new URLSearchParams({ work: match.workId, offset: String(offset) });
      if (match.editionId) parameters.set('edition', match.editionId);
      const response = await fetch('/api/catalog/editions?' + parameters, { signal: request.signal });
      if (!response.ok) throw new Error('Editions unavailable');
      const result = await response.json() as CatalogEditions;
      if (request.signal.aborted) return;
      const editions = new Map(previous.map(edition => [edition.id, edition]));
      for (const edition of result.editions) editions.set(edition.id, edition);
      this.editionPicker.set({ match, editions: [...editions.values()], nextOffset: result.nextOffset });
    } catch {
      if (!request.signal.aborted) this.catalogError.set('No se pudieron cargar las ediciones. Volvé a intentar.');
    } finally {
      if (this.editionRequest === request) {
        this.editionRequest = undefined;
        this.loadingEditions.set(false);
      }
    }
  }

  closeEditions(): void {
    this.editionRequest?.abort();
    this.editionRequest = undefined;
    this.loadingEditions.set(false);
    this.editionPicker.set(null);
  }

  async importBook(match: CatalogMatch, edition?: CatalogEdition): Promise<void> {
    if (this.saving() || !this.ready()) return;
    this.saving.set(true);
    this.catalogError.set('');
    try {
      const parameters = new URLSearchParams({ work: match.workId });
      if (edition) parameters.set('edition', edition.id);
      const response = await fetch('/api/catalog/book?' + parameters);
      if (!response.ok) throw new Error('Edition unavailable');
      const detail = await response.json() as Pick<Book, 'summary' | 'coverId' | 'totalPages'>;
      const catalogId = edition?.id ?? match.workId;
      this.saveBook({
        id: crypto.randomUUID(), catalogId, title: edition?.title ?? match.title, author: match.author,
        language: edition?.language ?? undefined, publicationYear: edition?.publicationYear ?? undefined,
        summary: detail.summary ?? undefined, totalPages: detail.totalPages ?? edition?.totalPages ?? undefined,
        coverId: detail.coverId ?? match.coverId ?? undefined,
      }, id => {
        this.closeEditions();
        if (this.view() === 'library') this.go(this.bookLink(id).slice(1));
      }, message => this.catalogError.set(message));
    } catch {
      this.saving.set(false);
      this.catalogError.set('No se pudo cargar la ficha del catálogo. Volvé a intentar o agregala manualmente.');
    }
  }

  async saveQuickPage(event: Event, id: string, field: HTMLInputElement): Promise<void> {
    event.preventDefault();
    await this.changeQuickPage(id, book => updateReadingPage(book, field.valueAsNumber));
  }

  async markNextSection(id: string, section: BookSection): Promise<void> {
    await this.changeQuickPage(id, book => {
      const end = book.sections?.find(item => item.id === section.id)?.endPage;
      return end ? updateReadingPage(book, Math.max(book.page ?? 0, end)) : null;
    });
  }

  private async changeQuickPage(id: string, change: (book: Book) => Book | null): Promise<void> {
    const database = this.database();
    if (!database || this.saving()) return;
    this.saving.set(true);
    this.collectionError.set('');
    this.collectionStatus.set('');
    try {
      this.publishBooks(await editBook(database, id, change));
      this.collectionStatus.set('Avance guardado.');
    } catch {
      this.collectionError.set('No se pudo guardar el avance. Revisá el total de páginas y volvé a intentar.');
    } finally { this.saving.set(false); }
  }

  private publishBooks(books: Book[]): void {
    const panel = this.studyPanel();
    if (panel) panel.applyBookChanges(books);
    else this.replaceBooks(books);
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
            language: book.language ?? local.language, publicationYear: book.publicationYear ?? local.publicationYear,
            coverId: book.coverId, totalPages: local.totalPages ?? book.totalPages });
        } else store.add(book);
        read = store.getAll();
      }
    };

    transaction.oncomplete = () => {
      this.publishBooks(read.result);
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
