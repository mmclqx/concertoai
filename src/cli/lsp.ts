/**
 * `concertoai lsp --stdio` CLI 入口（v4.0 M6 / T6.3）。
 *
 * 启动 Language Server（stdin/stdout Content-Length 帧），供 VS Code 等客户端
 * 通过一行配置连接：
 * ```
 * "concertoai.lsp.serverPath": "concertoai",
 * "concertoai.lsp.args": ["lsp", "--stdio"]
 * ```
 * 保存 .ts/.tsx 文件 → didSave → 三来源诊断（lint Warning / type Error /
 * self-heal Information）→ publishDiagnostics 推送 Problems 面板；
 * CodeAction「🔧 用 ConcertoAI 修复」/「移除未使用的 import」→ 一键修复。
 *
 * 设计：进程内单服务器；stdin 关闭/exit 通知退出（exit 码 0）；
 * 诊断子进程（biome/tsc）超时保护；所有输出走 Content-Length 帧（不污染 stdout）。
 */

import type { Readable, Writable } from 'node:stream';
import { resolveLocale, setLocale } from '../i18n';
import { ChildProcessDiagnosticRunner } from '../lsp/diagnostics';
import { LspServer } from '../lsp/server';
import { VERSION } from '../version';

export interface RunLspCommandOptions {
  /** 工作目录（biome/tsc 执行 cwd）。 */
  cwd: string;
  /** 界面语言（诊断消息中文/英文提示；协议不变）。 */
  lang?: string;
  /** 输入流（测试注入；缺省 process.stdin）。 */
  input?: Readable;
  /** 输出流（测试注入；缺省 process.stdout）。 */
  output?: Writable;
}

/** 启动 LSP 服务器（阻塞直到客户端断开/exit）。 */
export async function runLspCommand(options: RunLspCommandOptions): Promise<void> {
  const locale = resolveLocale(options.lang);
  setLocale(locale);

  const server = new LspServer({
    cwd: options.cwd,
    input: options.input ?? (process.stdin as Readable),
    output: options.output ?? (process.stdout as Writable),
    runner: new ChildProcessDiagnosticRunner(),
    version: VERSION,
  });

  await server.run();
}
