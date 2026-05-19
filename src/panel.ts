import * as vscode from 'vscode';
import { CursorInstall, locateCursorInstall, validateCursorRoot } from './cursorLocator';
import { applyWorkbenchPatch, getPatchMetadata, PatchScanResult, restoreWorkbenchBackup, scanWorkbenchPatch } from './workbenchPatcher';

interface ManagerState {
  cursorRoot?: string;
  install?: CursorInstall;
  patch?: PatchScanResult;
  logs: readonly string[];
}

interface WebviewMessage {
  readonly command: 'autoLocate' | 'chooseRoot' | 'rescan' | 'applyPatch' | 'restoreBackup' | 'openReport';
}

export class ManagerPanel {
  public static current?: ManagerPanel;

  private readonly logs: string[] = [];
  private state: ManagerState = { logs: this.logs };
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext
  ) {
    this.panel.onDidDispose(() => this.dispose(), undefined, this.context.subscriptions);
    this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message as WebviewMessage), undefined, this.context.subscriptions);
    void this.refresh(true);
  }

  public static reveal(context: vscode.ExtensionContext): void {
    if (ManagerPanel.current) {
      ManagerPanel.current.panel.reveal(vscode.ViewColumn.One);
      void ManagerPanel.current.refresh(false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'cursorZhCnManager',
      'Cursor 汉化管理器',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    ManagerPanel.current = new ManagerPanel(panel, context);
  }

  private dispose(): void {
    this.disposed = true;
    ManagerPanel.current = undefined;
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.command) {
        case 'autoLocate':
          await this.autoLocate();
          break;
        case 'chooseRoot':
          await this.chooseRoot();
          break;
        case 'rescan':
          await this.refresh(true);
          break;
        case 'applyPatch':
          await this.applyPatch();
          break;
        case 'restoreBackup':
          await this.restoreBackup();
          break;
        case 'openReport':
          await this.openReport();
          break;
      }
    } catch (error) {
      this.log(error instanceof Error ? error.message : String(error));
      this.render();
    }
  }

  private async refresh(scanOnly: boolean): Promise<void> {
    const configuredRoot = vscode.workspace.getConfiguration('cursorZhCn').get<string>('cursorRoot')?.trim();

    if (!configuredRoot && scanOnly) {
      await this.autoLocate();
      return;
    }

    if (configuredRoot) {
      await this.loadRoot(configuredRoot, '已保存配置');
    } else {
      this.state = { cursorRoot: undefined, logs: this.logs };
    }

    this.render();
  }

  private async autoLocate(): Promise<void> {
    this.log('开始自动识别 Cursor 安装目录。');
    const configuredRoot = vscode.workspace.getConfiguration('cursorZhCn').get<string>('cursorRoot');
    const result = await locateCursorInstall(configuredRoot);

    if (!result.install) {
      this.state = { logs: this.logs };
      this.log(`自动识别失败，已检查 ${result.candidates.length} 个候选路径。`);
      this.render();
      return;
    }

    await saveCursorRoot(result.install.root);
    await this.loadInstall(result.install);
    this.log(`已识别 Cursor ${result.install.version ?? '未知版本'}: ${result.install.root}`);
    this.render();
  }

  private async chooseRoot(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '选择 Cursor 安装目录'
    });

    const folder = selected?.[0]?.fsPath;
    if (!folder) {
      return;
    }

    const install = await validateCursorRoot(folder, '手动选择');
    if (!install.valid) {
      this.log(`目录校验失败: ${install.problems.join('；')}`);
      void vscode.window.showErrorMessage('所选目录不是有效的 Cursor 安装根目录。');
      this.state = { cursorRoot: folder, install, logs: this.logs };
      this.render();
      return;
    }

    await saveCursorRoot(install.root);
    await this.loadInstall(install);
    this.log(`已保存手动选择路径: ${install.root}`);
    this.render();
  }

  private async applyPatch(): Promise<void> {
    if (!this.state.install?.valid) {
      throw new Error('请先识别或选择有效的 Cursor 安装目录。');
    }

    const allowed = vscode.workspace.getConfiguration('cursorZhCn').get<boolean>('enableWorkbenchPatch', true);
    if (!allowed) {
      throw new Error('配置 cursorZhCn.enableWorkbenchPatch 已禁用，未执行补丁。');
    }

    const result = await applyWorkbenchPatch(this.state.install.root, this.context);
    this.state = { ...this.state, patch: result.after };
    this.log(result.changed
      ? `补丁已应用，命中 ${result.appliedRuleIds.length} 项，备份: ${result.backupPath}`
      : '补丁未写入：当前文件已经处于已应用或无需变更状态。');
    this.render();
  }

  private async restoreBackup(): Promise<void> {
    if (!this.state.install?.valid) {
      throw new Error('请先识别或选择有效的 Cursor 安装目录。');
    }

    const result = await restoreWorkbenchBackup(this.state.install.root, this.context);
    this.state = { ...this.state, patch: result.after };
    this.log(`已从备份恢复: ${result.backupPath}`);
    this.log(`恢复前当前文件已另存为: ${result.safetyBackupPath}`);
    this.render();
  }

  private async openReport(): Promise<void> {
    const report = vscode.Uri.joinPath(this.context.extensionUri, 'reports', 'coverage-report.md');
    try {
      await vscode.commands.executeCommand('vscode.open', report);
    } catch {
      void vscode.window.showWarningMessage('未找到覆盖率报告，请先运行 npm run extract 生成。');
    }
  }

  private async loadRoot(root: string, source: string): Promise<void> {
    const install = await validateCursorRoot(root, source);
    await this.loadInstall(install);
  }

  private async loadInstall(install: CursorInstall): Promise<void> {
    let patch: PatchScanResult | undefined;
    if (install.valid) {
      try {
        patch = await scanWorkbenchPatch(install.root, this.context);
      } catch (error) {
        this.log(error instanceof Error ? error.message : String(error));
      }
    }

    this.state = {
      cursorRoot: install.root,
      install,
      patch,
      logs: this.logs
    };
  }

  private log(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    this.logs.unshift(`[${timestamp}] ${message}`);
    this.logs.splice(80);
  }

  private render(): void {
    if (this.disposed) {
      return;
    }

    this.panel.webview.html = getHtml(this.panel.webview, this.context, this.state);
  }
}

async function saveCursorRoot(root: string): Promise<void> {
  await vscode.workspace.getConfiguration('cursorZhCn').update('cursorRoot', root, vscode.ConfigurationTarget.Global);
}

function getHtml(webview: vscode.Webview, context: vscode.ExtensionContext, state: ManagerState): string {
  const nonce = getNonce();
  const cspSource = webview.cspSource;
  const metadata = getPatchMetadata(context);
  const install = state.install;
  const patch = state.patch;
  const patchStatusText: Record<string, string> = {
    'not-applied': '未应用',
    applied: '已应用',
    partial: '部分应用',
    unknown: '未知'
  };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cursor 汉化管理器</title>
  <style>
    body { padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    .wrap { max-width: 1040px; margin: 0 auto; padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 22px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 16px; background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-button-background)); }
    .label { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 6px; }
    .value { overflow-wrap: anywhere; font-weight: 600; }
    .ok { color: var(--vscode-testing-iconPassed); }
    .warn { color: var(--vscode-testing-iconQueued); }
    .bad { color: var(--vscode-testing-iconFailed); }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 22px 0; }
    button { border: none; border-radius: 4px; padding: 8px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .section { margin-top: 18px; }
    .mono { font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .list { margin: 8px 0 0; padding-left: 18px; }
    .log { min-height: 160px; max-height: 300px; overflow: auto; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px; background: var(--vscode-input-background); }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>Cursor 汉化管理器</h1>
    <div class="subtitle">标准语言包继续通过 VS Code 本地化机制生效；补丁功能只处理 Cursor 私有硬编码界面。</div>

    <div class="grid">
      <div class="card">
        <div class="label">Cursor 路径</div>
        <div class="value mono">${escapeHtml(state.cursorRoot ?? '未识别')}</div>
      </div>
      <div class="card">
        <div class="label">检测状态</div>
        <div class="value ${install?.valid ? 'ok' : 'warn'}">${install?.valid ? `有效安装 / ${escapeHtml(install.version ?? '未知版本')}` : '未确认有效安装'}</div>
      </div>
      <div class="card">
        <div class="label">语言包状态</div>
        <div class="value ok">扩展已安装时自动提供 zh-cn 语言包贡献</div>
      </div>
      <div class="card">
        <div class="label">补丁状态</div>
        <div class="value ${patch?.state === 'applied' ? 'ok' : patch?.state === 'partial' ? 'warn' : ''}">${patch ? patchStatusText[patch.state] : '未扫描'}</div>
      </div>
      <div class="card">
        <div class="label">备份状态</div>
        <div class="value mono">${escapeHtml(metadata?.backupPath ?? '暂无备份记录')}</div>
      </div>
      <div class="card">
        <div class="label">补丁命中</div>
        <div class="value">${patch ? `${patch.targetHits} 个中文目标 / ${patch.sourceHits} 个英文源 / ${patch.totalRules} 条规则` : '未扫描'}</div>
      </div>
    </div>

    <div class="actions">
      <button data-command="autoLocate">自动识别</button>
      <button data-command="chooseRoot" class="secondary">手动选择 Cursor 路径</button>
      <button data-command="applyPatch">应用补丁</button>
      <button data-command="restoreBackup" class="secondary">恢复备份</button>
      <button data-command="rescan" class="secondary">重新扫描</button>
      <button data-command="openReport" class="secondary">打开报告</button>
    </div>

    ${install && !install.valid ? `<section class="section card"><div class="label">路径问题</div><ul class="list">${install.problems.map(problem => `<li>${escapeHtml(problem)}</li>`).join('')}</ul></section>` : ''}

    <section class="section card">
      <div class="label">关键文件</div>
      <div class="mono">${escapeHtml(install?.workbenchPath ?? '未确认')}</div>
      ${patch ? `<p><span class="pill">SHA-256</span> <span class="mono">${escapeHtml(patch.currentHash)}</span></p>` : ''}
    </section>

    <section class="section">
      <h2>操作日志</h2>
      <div class="log mono">${state.logs.length ? state.logs.map(escapeHtml).join('<br>') : '暂无日志'}</div>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-command]').forEach(button => {
      button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}