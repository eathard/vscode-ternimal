import { XtermWrapper } from './xtermWrapper';

export class SearchBar {
  private container: HTMLElement;
  private input: HTMLInputElement;
  private prevButton: HTMLElement;
  private nextButton: HTMLElement;
  private closeButton: HTMLElement;
  private wrapper: XtermWrapper | null = null;
  private visible: boolean = false;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'search-bar hidden';

    const inputWrap = document.createElement('div');
    inputWrap.className = 'search-bar-input-wrap';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'search-bar-input';
    this.input.placeholder = 'Find...';
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (e.shiftKey) {
          this.findPrevious();
        } else {
          this.findNext();
        }
      } else if (e.key === 'Escape') {
        this.hide();
      }
    });

    this.prevButton = document.createElement('button');
    this.prevButton.className = 'search-bar-btn';
    this.prevButton.textContent = '\u2191';
    this.prevButton.title = 'Previous (Shift+Enter)';
    this.prevButton.addEventListener('click', () => this.findPrevious());

    this.nextButton = document.createElement('button');
    this.nextButton.className = 'search-bar-btn';
    this.nextButton.textContent = '\u2193';
    this.nextButton.title = 'Next (Enter)';
    this.nextButton.addEventListener('click', () => this.findNext());

    this.closeButton = document.createElement('button');
    this.closeButton.className = 'search-bar-btn search-bar-close';
    this.closeButton.textContent = 'x';
    this.closeButton.title = 'Close (Escape)';
    this.closeButton.addEventListener('click', () => this.hide());

    inputWrap.appendChild(this.input);
    inputWrap.appendChild(this.prevButton);
    inputWrap.appendChild(this.nextButton);
    inputWrap.appendChild(this.closeButton);
    this.container.appendChild(inputWrap);
    parent.appendChild(this.container);
  }

  show(wrapper: XtermWrapper): void {
    this.wrapper = wrapper;
    this.visible = true;
    this.container.classList.remove('hidden');
    this.input.focus();
    this.input.select();
  }

  hide(): void {
    this.visible = false;
    this.container.classList.add('hidden');
    if (this.wrapper) {
      this.wrapper.terminal.focus();
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  toggle(wrapper: XtermWrapper): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show(wrapper);
    }
  }

  private findNext(): void {
    if (!this.wrapper) return;
    const term = this.input.value;
    if (term) {
      this.wrapper.searchAddon.findNext(term);
    }
  }

  private findPrevious(): void {
    if (!this.wrapper) return;
    const term = this.input.value;
    if (term) {
      this.wrapper.searchAddon.findPrevious(term);
    }
  }
}
