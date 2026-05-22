import * as vscode from 'vscode';
import { CursorInstall, locateCursorInstall, validateCursorRoot } from './cursorLocator';
import { applyNlsMessagePatch, NlsMessagePatchScanResult, restoreNlsMessageBackup, scanNlsMessagePatch, unapplyNlsMessagePatch } from './nlsMessagePatcher';
import { createScopedProgress, ProgressCallback, ProgressUpdate, reportProgress } from './progress';
import { applyWorkbenchPatch, PatchBackupInfo, PatchScanResult, restoreWorkbenchBackup, scanWorkbenchPatch, unapplyWorkbenchPatch } from './workbenchPatcher';

interface ManagerProgressState extends ProgressUpdate {
  readonly operation: string;
  readonly startedAt: string;
}

interface ManagerState {
  cursorRoot?: string;
  install?: CursorInstall;
  patch?: PatchScanResult;
  nlsPatch?: NlsMessagePatchScanResult;
  progress?: ManagerProgressState;
  logs: readonly string[];
}

interface WebviewMessage {
  readonly command: 'autoLocate' | 'chooseRoot' | 'rescan' | 'applyPatch' | 'unapplyPatch' | 'restoreWorkbenchBackup' | 'restoreNlsBackup' | 'openReport';
  readonly backupPath?: string;
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
    void this.refresh(true, '管理器加载');
  }

  public static reveal(context: vscode.ExtensionContext): void {
    if (ManagerPanel.current) {
      ManagerPanel.current.panel.reveal(vscode.ViewColumn.One);
      void ManagerPanel.current.refresh(false, '管理器刷新');
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

  private async runOperation<T>(operation: string, task: (progress: ProgressCallback) => Promise<T>): Promise<T | undefined> {
    if (this.state.progress) {
      this.log(`已有操作正在进行：${this.state.progress.operation}`);
      this.render();
      return undefined;
    }

    const startedAt = new Date().toISOString();
    const progress: ProgressCallback = update => {
      this.updateState({
        progress: {
          ...update,
          operation,
          startedAt
        }
      });
      this.render();
    };

    try {
      await reportProgress(progress, { message: '准备开始', percent: 0 });
      return await task(progress);
    } finally {
      this.updateState({ progress: undefined });
      this.render();
    }
  }

  private updateState(update: Omit<Partial<ManagerState>, 'logs'>): void {
    this.state = {
      ...this.state,
      ...update,
      logs: this.logs
    };
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
          await this.refresh(true, '重新扫描');
          break;
        case 'applyPatch':
          await this.applyPatch();
          break;
        case 'unapplyPatch':
          await this.unapplyPatch();
          break;
        case 'restoreWorkbenchBackup':
          await this.restoreWorkbenchBackup(message.backupPath);
          break;
        case 'restoreNlsBackup':
          await this.restoreNlsBackup(message.backupPath);
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

  private async refresh(scanOnly: boolean, operation = scanOnly ? '重新扫描' : '管理器刷新'): Promise<void> {
    await this.runOperation(operation, async progress => {
      const configuredRoot = vscode.workspace.getConfiguration('cursorZhCn').get<string>('cursorRoot')?.trim();

      if (!configuredRoot && scanOnly) {
        await this.autoLocateCore(createScopedProgress(progress, 5, 100, '自动识别'));
        return;
      }

      if (configuredRoot) {
        await this.loadRoot(configuredRoot, '已保存配置', progress);
      } else {
        this.updateState({ cursorRoot: undefined, install: undefined, patch: undefined, nlsPatch: undefined });
        await reportProgress(progress, { message: '未配置 Cursor 安装目录', percent: 100 });
      }
    });
  }

  private async autoLocate(): Promise<void> {
    await this.runOperation('自动识别', progress => this.autoLocateCore(progress));
  }

  private async autoLocateCore(progress: ProgressCallback | undefined): Promise<void> {
    this.log('开始自动识别 Cursor 安装目录。');
    const configuredRoot = vscode.workspace.getConfiguration('cursorZhCn').get<string>('cursorRoot');
    const result = await locateCursorInstall(configuredRoot, createScopedProgress(progress, 0, 70, '识别安装目录'));

    if (!result.install) {
      this.updateState({ cursorRoot: undefined, install: undefined, patch: undefined, nlsPatch: undefined });
      this.log(`自动识别失败，已检查 ${result.candidates.length} 个候选路径。`);
      await reportProgress(progress, {
        message: `自动识别失败，已检查 ${result.candidates.length} 个候选路径`,
        percent: 100,
        current: result.candidates.length,
        total: result.candidates.length
      });
      return;
    }

    await reportProgress(progress, { message: '保存识别到的 Cursor 路径', percent: 72 });
    await saveCursorRoot(result.install.root);
    await this.loadInstall(result.install, createScopedProgress(progress, 75, 99, '加载安装数据'));
    this.log(`已识别 Cursor ${result.install.version ?? '未知版本'}: ${result.install.root}`);
    await reportProgress(progress, { message: '自动识别完成', percent: 100 });
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

    await this.runOperation('手动选择 Cursor 路径', async progress => {
      const install = await validateCursorRoot(folder, '手动选择', createScopedProgress(progress, 0, 35, '校验安装目录'));
      if (!install.valid) {
        this.log(`目录校验失败: ${install.problems.join('；')}`);
        void vscode.window.showErrorMessage('所选目录不是有效的 Cursor 安装根目录。');
        this.updateState({ cursorRoot: folder, install, patch: undefined, nlsPatch: undefined });
        await reportProgress(progress, { message: '目录校验失败', percent: 100, current: 0, total: 1 });
        return;
      }

      await reportProgress(progress, { message: '保存手动选择路径', percent: 40, current: 1, total: 1 });
      await saveCursorRoot(install.root);
      await this.loadInstall(install, createScopedProgress(progress, 45, 99, '加载安装数据'));
      this.log(`已保存手动选择路径: ${install.root}`);
      await reportProgress(progress, { message: '手动选择完成', percent: 100, current: 1, total: 1 });
    });
  }

  private async applyPatch(): Promise<void> {
    await this.runOperation('应用补丁', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const allowed = vscode.workspace.getConfiguration('cursorZhCn').get<boolean>('enableWorkbenchPatch', true);
      if (!allowed) {
        throw new Error('配置 cursorZhCn.enableWorkbenchPatch 已禁用，未执行补丁。');
      }

      const result = await applyWorkbenchPatch(install.root, this.context, createScopedProgress(progress, 0, 62, 'Workbench 补丁'));
      const nlsResult = await applyNlsMessagePatch(install.root, this.context, createScopedProgress(progress, 62, 100, 'NLS 消息表补丁'));
      this.updateState({ patch: result.after, nlsPatch: nlsResult.after });
      this.log(`Cursor 根目录: ${result.after.cursorRoot}`);
      this.log(`Workbench 文件: ${result.after.filePath}`);
      this.log(`NLS 消息表: ${nlsResult.after.filePath}`);
      this.log(`Workbench 补丁命中: 英文源 ${result.before.sourceHits} 处，已翻译 ${result.before.targetHits} 处，本次写入 ${result.appliedRuleIds.length} 项/${result.appliedOccurrences} 处。`);
      this.log(`NLS 补丁命中: 英文源 ${nlsResult.before.sourceHits} 处，已翻译 ${nlsResult.before.targetHits} 处，本次写入 ${nlsResult.appliedRuleIds.length} 项/${nlsResult.appliedOccurrences} 处。`);
      this.log(result.changed
        ? `Workbench 补丁已应用，备份: ${result.backupPath}`
        : `Workbench 补丁未写入：英文源 ${result.before.sourceHits} 处，已翻译 ${result.before.targetHits} 处。`);
      this.log(nlsResult.changed
        ? `NLS 消息表补丁已应用，备份: ${nlsResult.backupPath}`
        : `NLS 消息表补丁未写入：英文源 ${nlsResult.before.sourceHits} 处，已翻译 ${nlsResult.before.targetHits} 处。`);
    });
  }

  private async unapplyPatch(): Promise<void> {
    await this.runOperation('卸载补丁', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const result = await unapplyWorkbenchPatch(install.root, this.context, createScopedProgress(progress, 0, 62, 'Workbench 补丁'));
      const nlsResult = await unapplyNlsMessagePatch(install.root, this.context, createScopedProgress(progress, 62, 100, 'NLS 消息表补丁'));
      this.updateState({ patch: result.after, nlsPatch: nlsResult.after });
      this.log(`Workbench 文件: ${result.after.filePath}`);
      this.log(`NLS 消息表: ${nlsResult.after.filePath}`);
      this.log(result.changed
        ? `Workbench 补丁已卸载，反向处理 ${result.unappliedRuleIds.length} 项，卸载前快照: ${result.safetyBackupPath}`
        : 'Workbench 补丁未卸载：当前文件没有命中已应用的中文补丁。');
      this.log(nlsResult.changed
        ? `NLS 消息表补丁已卸载，反向处理 ${nlsResult.unappliedRuleIds.length} 项，卸载前快照: ${nlsResult.safetyBackupPath}`
        : 'NLS 消息表补丁未卸载：当前文件没有命中已应用的中文补丁。');
    });
  }

  private async restoreWorkbenchBackup(backupPath?: string): Promise<void> {
    await this.runOperation('恢复 Workbench 备份', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const selectedBackupPath = backupPath ?? this.state.patch?.backups.find(backup => backup.currentMetadataBackup)?.path ?? this.state.patch?.backups[0]?.path;
      if (!selectedBackupPath) {
        throw new Error('没有可恢复的 Workbench 备份文件。');
      }

      const result = await restoreWorkbenchBackup(install.root, this.context, selectedBackupPath, progress);
      this.updateState({ patch: result.after });
      this.log(`Workbench 已从备份恢复: ${result.backupPath}`);
      this.log(`Workbench 恢复前快照: ${result.safetyBackupPath}`);
    });
  }

  private async restoreNlsBackup(backupPath?: string): Promise<void> {
    await this.runOperation('恢复 NLS 消息表备份', async progress => {
      const install = this.state.install;
      if (!install?.valid) {
        throw new Error('请先识别或选择有效的 Cursor 安装目录。');
      }

      const selectedBackupPath = backupPath ?? this.state.nlsPatch?.backups.find(backup => backup.currentMetadataBackup)?.path ?? this.state.nlsPatch?.backups[0]?.path;
      if (!selectedBackupPath) {
        throw new Error('没有可恢复的 NLS 消息表备份文件。');
      }

      const result = await restoreNlsMessageBackup(install.root, this.context, selectedBackupPath, progress);
      this.updateState({ nlsPatch: result.after });
      this.log(`NLS 消息表已从备份恢复: ${result.backupPath}`);
      this.log(`NLS 消息表恢复前快照: ${result.safetyBackupPath}`);
    });
  }

  private async openReport(): Promise<void> {
    const report = vscode.Uri.joinPath(this.context.extensionUri, 'reports', 'coverage-report.md');
    try {
      await vscode.commands.executeCommand('vscode.open', report);
    } catch {
      void vscode.window.showWarningMessage('未找到覆盖率报告，请先运行 npm run extract 生成。');
    }
  }

  private async loadRoot(root: string, source: string, progress?: ProgressCallback): Promise<void> {
    const install = await validateCursorRoot(root, source, createScopedProgress(progress, 0, 30, '校验安装目录'));
    await this.loadInstall(install, createScopedProgress(progress, 30, 100, '加载安装数据'));
  }

  private async loadInstall(install: CursorInstall, progress?: ProgressCallback): Promise<void> {
    let patch: PatchScanResult | undefined;
    let nlsPatch: NlsMessagePatchScanResult | undefined;
    await reportProgress(progress, { message: '准备加载安装数据', percent: 0 });

    if (install.valid) {
      try {
        patch = await scanWorkbenchPatch(install.root, this.context, createScopedProgress(progress, 10, 55, '扫描 Workbench 补丁数据'));
      } catch (error) {
        this.log(error instanceof Error ? error.message : String(error));
      }

      try {
        nlsPatch = await scanNlsMessagePatch(install.root, this.context, createScopedProgress(progress, 55, 95, '扫描 NLS 消息表补丁数据'));
      } catch (error) {
        this.log(error instanceof Error ? error.message : String(error));
      }
    }

    this.updateState({
      cursorRoot: install.root,
      install,
      patch,
      nlsPatch
    });
    await reportProgress(progress, {
      message: install.valid ? '安装数据加载完成' : '安装目录无效',
      percent: 100,
      current: install.valid ? 1 : 0,
      total: 1
    });
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
  const install = state.install;
  const patch = state.patch;
  const nlsPatch = state.nlsPatch;
  const patchStatusText: Record<string, string> = {
    'not-applied': '未应用',
    applied: '已应用',
    partial: '部分应用',
    unknown: '未知'
  };
  const backupOptions = renderBackupOptions(patch?.backups ?? [], patchStatusText);
  const selectedBackup = getSelectedBackup(patch?.backups ?? []);
  const nlsBackupOptions = renderBackupOptions(nlsPatch?.backups ?? [], patchStatusText);
  const selectedNlsBackup = getSelectedBackup(nlsPatch?.backups ?? []);
  const progressSection = renderProgressSection(state.progress);
  const busyAttribute = state.progress ? ' disabled' : '';

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
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    button:disabled:hover { background: var(--vscode-button-background); }
    button.secondary:disabled:hover { background: var(--vscode-button-secondaryBackground); }
    .progress { margin: 18px 0 22px; border-left: 3px solid var(--vscode-progressBar-background); }
    .progress-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .progress-title { font-weight: 700; }
    .progress-percent { color: var(--vscode-descriptionForeground); }
    .progress-message { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    .progress-track { height: 8px; margin-top: 12px; overflow: hidden; border-radius: 999px; background: var(--vscode-editorWidget-background); }
    .progress-fill { height: 100%; border-radius: inherit; background: var(--vscode-progressBar-background); transition: width 120ms ease-out; }
    .progress-count { margin-top: 8px; color: var(--vscode-descriptionForeground); }
    .section { margin-top: 18px; }
    .mono { font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .list { margin: 8px 0 0; padding-left: 18px; }
    .backup-select { width: 100%; margin-top: 10px; padding: 6px 8px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; }
    .backup-detail { margin-top: 8px; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
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
        <div class="label">Workbench 补丁状态</div>
        <div class="value ${patch?.state === 'applied' ? 'ok' : patch?.state === 'partial' ? 'warn' : ''}">${patch ? patchStatusText[patch.state] : '未扫描'}</div>
      </div>
      <div class="card">
        <div class="label">NLS 消息表补丁状态</div>
        <div class="value ${nlsPatch?.state === 'applied' ? 'ok' : nlsPatch?.state === 'partial' ? 'warn' : ''}">${nlsPatch ? patchStatusText[nlsPatch.state] : '未扫描'}</div>
      </div>
      <div class="card">
        <div class="label">Workbench 备份状态</div>
        <div class="value">${patch ? `${patch.backups.length} 个可选备份` : '未扫描'}</div>
        <select id="workbenchBackupSelect" class="backup-select" ${patch?.backups.length ? '' : 'disabled'}>
          ${backupOptions}
        </select>
        ${selectedBackup ? `<div class="backup-detail mono">${escapeHtml(formatBackupDetail(selectedBackup, patchStatusText))}</div>` : '<div class="backup-detail mono">暂无备份记录</div>'}
      </div>
      <div class="card">
        <div class="label">NLS 消息表备份状态</div>
        <div class="value">${nlsPatch ? `${nlsPatch.backups.length} 个可选备份` : '未扫描'}</div>
        <select id="nlsBackupSelect" class="backup-select" ${nlsPatch?.backups.length ? '' : 'disabled'}>
          ${nlsBackupOptions}
        </select>
        ${selectedNlsBackup ? `<div class="backup-detail mono">${escapeHtml(formatBackupDetail(selectedNlsBackup, patchStatusText))}</div>` : '<div class="backup-detail mono">暂无备份记录</div>'}
      </div>
      <div class="card">
        <div class="label">Workbench 补丁命中</div>
        <div class="value">${patch ? `${patch.targetHits} 个中文目标 / ${patch.sourceHits} 个英文源 / ${patch.totalRules} 条规则` : '未扫描'}</div>
      </div>
      <div class="card">
        <div class="label">NLS 消息表补丁命中</div>
        <div class="value">${nlsPatch ? `${nlsPatch.targetHits} 个中文目标 / ${nlsPatch.sourceHits} 个英文源 / ${nlsPatch.totalRules} 条规则` : '未扫描'}</div>
      </div>
    </div>

    <div class="actions">
      <button data-command="autoLocate"${busyAttribute}>自动识别</button>
      <button data-command="chooseRoot" class="secondary"${busyAttribute}>手动选择 Cursor 路径</button>
      <button data-command="applyPatch"${busyAttribute}>应用补丁</button>
      <button data-command="unapplyPatch" class="secondary"${busyAttribute}>卸载补丁</button>
      <button data-command="restoreWorkbenchBackup" class="secondary"${busyAttribute}>恢复 Workbench 备份</button>
      <button data-command="restoreNlsBackup" class="secondary"${busyAttribute}>恢复 NLS 备份</button>
      <button data-command="rescan" class="secondary"${busyAttribute}>重新扫描</button>
      <button data-command="openReport" class="secondary">打开报告</button>
    </div>

    ${progressSection}

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
      button.addEventListener('click', () => {
        const command = button.dataset.command;
        const backupSelectId = command === 'restoreWorkbenchBackup'
          ? 'workbenchBackupSelect'
          : command === 'restoreNlsBackup'
            ? 'nlsBackupSelect'
            : undefined;
        const backupSelect = backupSelectId ? document.getElementById(backupSelectId) : undefined;
        vscode.postMessage({
          command,
          backupPath: backupSelect instanceof HTMLSelectElement ? backupSelect.value : undefined
        });
      });
    });
  </script>
</body>
</html>`;
}

function renderProgressSection(progress: ManagerProgressState | undefined): string {
  if (!progress) {
    return '';
  }

  const count = progress.current !== undefined && progress.total !== undefined
    ? `<div class="progress-count mono">当前条数：${progress.current} / ${progress.total}</div>`
    : '';

  return `<section class="section card progress" aria-live="polite">
    <div class="progress-head">
      <div class="progress-title">${escapeHtml(progress.operation)}</div>
      <div class="progress-percent mono">${progress.percent}%</div>
    </div>
    <div class="progress-message">${escapeHtml(progress.message)}</div>
    <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}">
      <div class="progress-fill" style="width: ${progress.percent}%"></div>
    </div>
    ${count}
  </section>`;
}

function getSelectedBackup(backups: readonly PatchBackupInfo[]): PatchBackupInfo | undefined {
  return backups.find(backup => backup.currentMetadataBackup) ?? backups[0];
}

function renderBackupOptions(backups: readonly PatchBackupInfo[], patchStatusText: Record<string, string>): string {
  if (backups.length === 0) {
    return '<option value="">暂无备份记录</option>';
  }

  const selectedBackup = getSelectedBackup(backups);
  return backups.map(backup => {
    const selected = selectedBackup?.path === backup.path ? ' selected' : '';
    return `<option value="${escapeHtml(backup.path)}"${selected}>${escapeHtml(formatBackupOption(backup, patchStatusText))}</option>`;
  }).join('');
}

function formatBackupOption(backup: PatchBackupInfo, patchStatusText: Record<string, string>): string {
  const markers = [formatBackupKind(backup), patchStatusText[backup.status.state] ?? backup.status.state];

  if (backup.currentMetadataBackup) {
    markers.push('当前补丁备份');
  }

  return `${markers.join(' / ')} · ${formatDateTime(backup.modifiedAt)} · ${backup.name}`;
}

function formatBackupDetail(backup: PatchBackupInfo, patchStatusText: Record<string, string>): string {
  const patchState = patchStatusText[backup.status.state] ?? backup.status.state;
  return `${formatBackupKind(backup)}；补丁状态: ${patchState}；中文目标 ${backup.status.targetHits} / 英文源 ${backup.status.sourceHits}；${backup.path}`;
}

function formatBackupKind(backup: PatchBackupInfo): string {
  if (backup.isOriginal) {
    return '原始官方备份';
  }

  if (backup.kind === 'original') {
    return '原始备份候选';
  }

  if (backup.kind === 'before-restore') {
    return '恢复前快照';
  }

  if (backup.kind === 'before-uninstall') {
    return '卸载前快照';
  }

  return '未知备份';
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('zh-CN', { hour12: false });
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