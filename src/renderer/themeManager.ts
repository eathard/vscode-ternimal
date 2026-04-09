import darkTheme from '../shared/themes/dark.json';
import lightTheme from '../shared/themes/light.json';

export interface Theme {
  name: string;
  colors: Record<string, string>;
}

const THEMES: Record<string, Theme> = {
  dark: { name: 'Dark', colors: darkTheme },
  light: { name: 'Light', colors: lightTheme },
};

export class ThemeManager {
  private currentThemeName: string;
  private changeCallbacks: ((theme: Record<string, string>) => void)[] = [];

  constructor() {
    const saved = localStorage.getItem('ternimal-theme');
    this.currentThemeName = saved && THEMES[saved] ? saved : 'dark';
  }

  getCurrentTheme(): Record<string, string> {
    return THEMES[this.currentThemeName].colors;
  }

  getCurrentThemeName(): string {
    return this.currentThemeName;
  }

  setTheme(name: string): void {
    if (THEMES[name]) {
      this.currentThemeName = name;
      localStorage.setItem('ternimal-theme', name);
      const theme = THEMES[name].colors;
      this.changeCallbacks.forEach((cb) => cb(theme));
    }
  }

  listThemes(): { id: string; name: string }[] {
    return Object.entries(THEMES).map(([id, theme]) => ({
      id,
      name: theme.name,
    }));
  }

  onThemeChange(callback: (theme: Record<string, string>) => void): void {
    this.changeCallbacks.push(callback);
  }
}
