import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDoctorCommand } from '../../src/cli/doctor';

let tmp: string;
let log: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'concertoai-doctor-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  log?.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okBalance = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00',
    },
  ],
};

const output = (): string => (log?.mock.calls ?? []).map((c: unknown[]) => String(c[0])).join('\n');

describe('runDoctorCommand', () => {
  it('全部正常时返回 0，输出环境信息与账户余额', async () => {
    const cfg = path.join(tmp, 'config.json');
    writeFileSync(cfg, '{"schemaVersion":1,"defaultModel":"deepseek-v4-flash"}', 'utf8');

    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: cfg,
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => jsonResponse(okBalance),
    });

    expect(code).toBe(0);
    const out = output();
    expect(out).toContain('ConcertoAI 环境诊断');
    expect(out).toContain('✅ Node.js');
    expect(out).toContain('✅ API Key: 已设置');
    expect(out).toContain('✅ 配置文件');
    expect(out).toContain('schema v1');
    expect(out).toContain('✅ 会话目录');
    expect(out).toContain('✅ 模型表');
    expect(out).toContain('💰 账户余额: 账户可用');
    expect(out).toContain('CNY: 总额 110.00');
  });

  it('缺少 API Key 时返回 1 且余额标记跳过', async () => {
    const code = await runDoctorCommand({
      apiKey: undefined,
      configPath: path.join(tmp, 'config.json'),
      sessionDir: path.join(tmp, 'sessions'),
    });
    expect(code).toBe(1);
    const out = output();
    expect(out).toContain('❌ API Key');
    expect(out).toContain('未设置（无法查询余额）');
    expect(out).toContain('未查询（缺少 DEEPSEEK_API_KEY）');
  });

  it('余额查询失败时返回 1 且输出失败原因', async () => {
    const code = await runDoctorCommand({
      apiKey: 'bad',
      configPath: path.join(tmp, 'config.json'),
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => new Response('{"error":{}}', { status: 401 }),
    });
    expect(code).toBe(1);
    expect(output()).toContain('❌ 账户余额: 查询失败');
  });

  it('配置文件损坏时返回 1 并报告读取失败', async () => {
    const cfg = path.join(tmp, 'config.json');
    writeFileSync(cfg, 'not-json{', 'utf8');
    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: cfg,
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(code).toBe(1);
    expect(output()).toContain('❌ 配置文件');
    expect(output()).toContain('读取失败');
  });

  it('配置文件不存在时按正常处理（使用默认配置）', async () => {
    const code = await runDoctorCommand({
      apiKey: 'k',
      configPath: path.join(tmp, 'missing.json'),
      sessionDir: path.join(tmp, 'sessions'),
      fetchImpl: async () => jsonResponse(okBalance),
    });
    expect(code).toBe(0);
    expect(output()).toContain('✅ 配置文件');
    expect(output()).toContain('不存在，使用默认配置');
  });
});
