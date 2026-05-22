# Cursor 简体中文语言包

这是一个面向 Windows 版本 Cursor 的补充语言包扩展：
本插件只处理 Cursor 专用扩展和 Cursor 私有硬编码界面；
VS Code 基础翻译请使用官方的 `MS-CEINTL.vscode-language-pack-zh-hans`。

## 覆盖范围

- Cursor 专用可本地化扩展，例如 `anysphere.cursor-*`。
- 可选补丁 `workbench.desktop.main.js` 中高置信度的 Cursor 私有硬编码设置页文案。
- 不生成、不打包 `translations/main.i18n.json`。
- 不生成、不打包 `vscode.*`、`ms-vscode.*` 等官方/通用内置扩展翻译。

标准语言包资源不会修改 Cursor 安装目录的文件。只有在命令面板中打开 `Cursor 汉化管理器` 并点击 `应用补丁` 时，才会修改 Cursor 安装目录下的 `workbench.desktop.main.js`。补丁会先生成备份，并支持从管理器恢复。

## 基础中文语言包

请使用官方扩展提供 VS Code 基础中文翻译：

```powershell
cursor --install-extension MS-CEINTL.vscode-language-pack-zh-hans
```

本插件只作为 Cursor 专用补充层，避免复制和覆盖官方完整翻译。

## 生成翻译

默认扫描 `D:\cursor`

```powershell
npm run extract
```

也可以指定 Cursor 根目录：

```powershell
node .\scripts\extract-cursor-nls.mjs D:\cursor
```

生成结果：

- `translations/extensions/anysphere.cursor-*.i18n.json`
- `reports/coverage-report.md`
- `reports/untranslated-extensions.json`

运行生成脚本时会清理旧的完整主包和官方/通用内置扩展翻译产物，包括 `translations/main.i18n.json` 和 `translations/extensions/vscode*.i18n.json` 等。覆盖率报告只统计本插件负责的 Cursor 专用扩展。硬编码在 Cursor 主 bundle 中的文案不会被写入语言包资源，只能通过管理器中的补丁功能处理。

## 检索 workbench 未汉化硬编码文案

默认扫描 `D:\cursor` 中的 `workbench.desktop.main.js`：

```powershell
npm run scan:workbench
```

也可以指定 Cursor 根目录：

```powershell
node .\scripts\scan-workbench-untranslated.mjs D:\cursor
```

生成结果：

- `reports/workbench-untranslated.json`：完整候选、出现次数、位置和上下文。
- `reports/workbench-untranslated.md`：便于人工筛选的候选表。

扫描脚本只负责发现疑似未汉化英文硬编码字符串，不会修改 Cursor 安装目录。候选过滤规则位于 `data/workbench-untranslated-scan-config.json`，重点观察词位于 `data/workbench-hardcoded-needles.json`，补丁替换表位于 `data/workbench-patches.json`，避免把汉化列表直接内嵌到脚本代码中。

## 开发与打包

```powershell
npm install
npm run compile
npm run package
```

产物为当前目录下的 `.vsix` 文件。`npm run package` 会在打包前自动执行 TypeScript 编译。

## 安装和启用

```powershell
cursor --install-extension MS-CEINTL.vscode-language-pack-zh-hans
cursor --install-extension .\cursor-zh-cn-pack-0.0.1.vsix
```

安装后在 Cursor 中执行：

1. 打开命令面板。
2. 运行 `Configure Display Language`。
3. 选择 `zh-cn` / `简体中文`。
4. 重启 Cursor。

## Cursor 汉化管理器

安装扩展后，在命令面板运行 `Cursor 汉化管理器`。

管理器提供：

- 自动识别 Cursor 安装目录。
- 手动选择并保存 Cursor 安装目录。
- 显示语言包状态、补丁状态、备份路径、当前文件哈希和操作日志。
- 对 `workbench.desktop.main.js` 应用补丁式汉化。
- 从备份恢复补丁前文件；恢复前会再次备份当前文件，避免覆盖手动修改。
- 打开覆盖率报告。

自动识别会优先使用 `cursorZhCn.cursorRoot` 配置，然后检查正在运行的 `Cursor.exe`、`PATH`、常见安装路径和注册表卸载项。有效 Cursor 根目录必须包含：

- `resources\app\out\nls.keys.json`
- `resources\app\out\nls.messages.json`
- `resources\app\out\vs\workbench\workbench.desktop.main.js`

## 补丁说明

补丁目标是 Cursor 私有设置页和常用界面中没有进入 NLS 表的硬编码文案，例如 `Plan & Usage`、`Agents`、`Models`、`Tools & MCPs`、`Cursor Account`、聊天标题栏、Agent 菜单、Composer 文案和编辑应用按钮等。

这些硬编码文本是本项目最主要的麻烦来源：同一个界面里有的词走标准语言包，有的词直接写死在压缩后的主 bundle 里，短词还会混在命令、状态、配置键和值里。结果就是用户看到一半中文一半英文，维护者还不能简单全局替换，只能逐个确认结构上下文后补丁处理。尤其是 `Agent`、`Apply`、`Accept`、`Reject`、`Composer` 这类高频界面词，本该走统一本地化资源，却散落在菜单、按钮、tooltip、aria-label 和运行时对象里，升级一次就可能换一批位置，维护体验很差。这种实现方式对本地化非常不友好，也让后续 Cursor 升级后的维护成本明显变高。

补丁策略：

- 修改前计算 `workbench.desktop.main.js` 的 SHA-256。
- 首次应用前在同目录生成 `workbench.desktop.main.js.cursor-zh-cn-pack.bak.<version>.<timestamp>`。
- 在扩展全局存储中记录 Cursor 路径、版本、原始哈希、补丁后哈希、备份路径和命中规则。
- 重复点击 `应用补丁` 会先扫描当前文件，已应用时不会重复写入。
- `General`、`Tab`、`Beta`、`Network` 等短词只在确定的对象属性上下文中替换，不做裸字符串全局替换。

Cursor 升级后 `workbench.desktop.main.js` 可能被覆盖或结构变化，需要重新打开管理器扫描并重新应用补丁。若扫描结果为 `未知`，不要直接补丁，先确认 Cursor 版本和文件路径。

## 配置项

- `cursorZhCn.cursorRoot`：Cursor 安装根目录，例如 `D:\cursor`。留空时由管理器自动识别。
- `cursorZhCn.enableWorkbenchPatch`：是否允许管理器修改 `workbench.desktop.main.js`，默认启用。

## 已知限制

本插件不复制官方 VS Code 中文翻译，也不接管完整主界面翻译。远程 Web 内容、运行时动态返回内容或未纳入补丁规则的低置信度硬编码文案，仍可能显示英文。