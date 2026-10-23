import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { logPath, type LogStore } from './types.ts';

/** 開発時だけ使うローカルファイルの保存先（LOG_SINK=file、NODE_ENV=development のときのみ。src/config.ts）。 */
export class FileLogStore implements LogStore {
  constructor(private readonly dir: string) {}

  private file(day: string) {
    return join(this.dir, logPath(day).replace(/^log\//, ''));
  }

  async append(day: string, line: string) {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file(day), line + '\n');
  }

  async read(day: string) {
    const f = this.file(day);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  }

  async days() {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((f) => /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)?.[1])
      .filter((d): d is string => !!d)
      .sort();
  }
}
