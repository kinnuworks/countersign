import type { Workspace } from './workspace';

/** One applied change set: everything written inside one approved tool call (or one inline edit). */
export interface ChangeSet {
  id: string;
  label: string;
  at: number;
  files: { path: string; before: string | null; after: string }[];
  undone: boolean;
}

/** Records every write so an applied change can be undone exactly, newest first. */
export class ChangeJournal {
  private sets: ChangeSet[] = [];
  private n = 0;
  listeners: ((sets: ChangeSet[]) => void)[] = [];

  record(label: string, files: ChangeSet['files']): ChangeSet {
    const set: ChangeSet = { id: `c${++this.n}`, label, at: Date.now(), files, undone: false };
    this.sets.push(set);
    this.emit();
    return set;
  }

  all(): ChangeSet[] {
    return [...this.sets];
  }

  lastActive(): ChangeSet | undefined {
    return [...this.sets].reverse().find(s => !s.undone);
  }

  /**
   * Restores the files of a change set. Refuses when a file changed after the set was applied,
   * so undo never silently throws away later work.
   */
  async undo(ws: Workspace, id?: string): Promise<{ ok: boolean; message: string; set?: ChangeSet }> {
    const set = id ? this.sets.find(s => s.id === id) : this.lastActive();
    if (!set) return { ok: false, message: 'Nothing to undo.' };
    if (set.undone) return { ok: false, message: `${set.label} is already undone.` };
    for (const f of set.files) {
      const now = await ws.readFile(f.path);
      if (now !== f.after) return { ok: false, message: `${f.path} changed after "${set.label}" was applied; undo it by hand or undo newer changes first.` };
    }
    for (const f of set.files) {
      if (f.before == null) await ws.deleteFile(f.path);
      else await ws.writeFile(f.path, f.before);
    }
    set.undone = true;
    this.emit();
    return { ok: true, message: `Undid "${set.label}" (${set.files.map(f => f.path).join(', ')}).`, set };
  }

  private emit() {
    for (const l of this.listeners) l(this.all());
  }
}
