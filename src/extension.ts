import * as vscode from 'vscode';
import { ManagerPanel } from './panel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('cursor-zh-cn-pack.openManager', () => {
      ManagerPanel.reveal(context);
    })
  );
}

export function deactivate(): void {
  // 扩展没有常驻资源需要释放。
}