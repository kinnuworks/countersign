import * as vscode from 'vscode';
import { assertInside, listWorkspaceFiles, safeRel, type Workspace } from '../core/workspace';

/**
 * The workspace as the editor sees it: reads include unsaved buffer text, and writes go through
 * WorkspaceEdit (so they land in the editor's own undo stack) and are then saved.
 */
export class VscodeWorkspace implements Workspace {
  constructor(public root: string, private rootUri: vscode.Uri) {}

  listFiles() {
    return listWorkspaceFiles(this.root);
  }

  private uri(rel: string) {
    return vscode.Uri.joinPath(this.rootUri, safeRel(this.root, rel));
  }

  async readFile(rel: string): Promise<string | null> {
    let uri: vscode.Uri;
    try {
      uri = this.uri(rel);
      await assertInside(this.root, safeRel(this.root, rel));
    } catch {
      return null;
    }
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    try {
      const st = await vscode.workspace.fs.stat(uri);
      if (st.type !== vscode.FileType.File || st.size > 400_000) return null;
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return null;
    }
  }

  async writeFile(rel: string, text: string): Promise<void> {
    await assertInside(this.root, safeRel(this.root, rel));
    const uri = this.uri(rel);
    const edit = new vscode.WorkspaceEdit();
    let exists = true;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      exists = false;
    }
    if (!exists) {
      edit.createFile(uri, { ignoreIfExists: true, contents: new TextEncoder().encode(text) });
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`could not create ${rel}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`could not edit ${rel}`);
    await doc.save();
  }

  async deleteFile(rel: string): Promise<void> {
    await assertInside(this.root, safeRel(this.root, rel));
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(this.uri(rel), { ignoreIfNotExists: true });
    await vscode.workspace.applyEdit(edit);
  }
}
