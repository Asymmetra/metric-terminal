/**
 * Vitest test-env bootstrap.
 *
 * jwt.ts reads/writes `window.localStorage`, but the current jsdom/Node env
 * exposes no usable Storage ("localStorage is not available because
 * --localstorage-file was not provided"). Install a minimal in-memory Storage
 * shim on `window.localStorage` ONLY when the real one is missing or throws.
 */

if (typeof window !== "undefined") {
  // Probe: is a working localStorage already present?
  let usable = false;
  try {
    const probe = "__vitest_ls_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    usable = true;
  } catch {
    usable = false;
  }

  if (!usable) {
    const store = new Map<string, string>();
    const shim: Storage = {
      get length() {
        return store.size;
      },
      getItem(key: string): string | null {
        return store.has(key) ? store.get(key)! : null;
      },
      setItem(key: string, value: string): void {
        store.set(String(key), String(value));
      },
      removeItem(key: string): void {
        store.delete(key);
      },
      clear(): void {
        store.clear();
      },
      key(index: number): string | null {
        return Array.from(store.keys())[index] ?? null;
      },
    };

    try {
      Object.defineProperty(window, "localStorage", {
        value: shim,
        configurable: true,
        writable: true,
      });
    } catch {
      // Some environments reject defineProperty on the window's localStorage
      // accessor — fall back to a direct assignment.
      (window as unknown as { localStorage: Storage }).localStorage = shim;
    }
  }
}
