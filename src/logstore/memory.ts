import type { LogStore } from './types.ts';

/** テスト用 */
export class MemoryLogStore implements LogStore {
  readonly files = new Map<string, string>();
  async append(day: string, line: string) {
    this.files.set(day, (this.files.get(day) ?? '') + line + '\n');
  }
  async read(day: string) {
    return this.files.get(day) ?? null;
  }
  async days() {
    return [...this.files.keys()].sort();
  }
}
