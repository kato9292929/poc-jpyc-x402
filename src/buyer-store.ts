import { closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RecordStore } from './buyer.ts';
import { FileLogStore } from './logstore/file.ts';

const lockName = (key: string) => key.replace(/[^0-9A-Za-z_-]/g, '_');

/** ローカル（CLI）：$dir/YYYY-MM-DD.jsonl とロックファイル */
export class FileRecordStore implements RecordStore {
  private readonly logs: FileLogStore;
  constructor(private readonly dir: string) {
    this.logs = new FileLogStore(dir);
  }
  append(day: string, line: string) {
    return this.logs.append(day, line);
  }
  read(day: string) {
    return this.logs.read(day);
  }
  async tryLock(key: string) {
    const d = join(this.dir, 'lock');
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    try {
      closeSync(openSync(join(d, lockName(key)), 'wx'));
      return true;
    } catch {
      return false;
    }
  }
  async unlock(key: string) {
    rmSync(join(this.dir, 'lock', lockName(key)), { force: true });
  }
}
