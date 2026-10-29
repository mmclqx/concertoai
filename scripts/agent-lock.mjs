#!/usr/bin/env node
// ConcertoAI —— agent 自声明锁（防「约定内我自己的第二个实例」并行写同一仓库）
//
// 【它是什么】
//   一个放在 .git/ 下的 JSON 锁文件 + 心跳。开工前 claim，跑任务期间 heartbeat，
//   收工 release。另一个实例来 claim 时若发现锁「新鲜且不是我」，直接报错退出。
//
// 【它不是什么 —— 必须明说，别当它是并行体检测器】
//   · 它防不了外部 agent（如 Codex）。对方不知道这个约定就不会写锁，锁对它完全无效。
//   · 它不做进程名 / 命令行嗅探。实测（2026-10-29）证明那条路走不通：
//     本机所有 agent 都跑在 node.exe 下，命令行里零 agent 关键词，
//     「哪个 node.exe 是哪个 agent」这个信息在进程表里根本不存在。
//   · 它防的是「忘了自己已经开了一个实例」，不是「有人在偷偷写」。
//   防外部 agent 只能靠编排层（一个仓库一个写者）+ 事后 trailer 审计（AGENTS 第 30 条）。
//
// 【用法】
//   node scripts/agent-lock.mjs status
//   node scripts/agent-lock.mjs claim --owner concertoai-loop
//   node scripts/agent-lock.mjs heartbeat --owner concertoai-loop
//   node scripts/agent-lock.mjs release --owner concertoai-loop
//
// 【退出码】0 = 可用 / 成功　1 = 被他人持有（新鲜）　2 = 用法或环境错误
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TTL_MS = 10 * 60 * 1000; // 心跳超过 10 分钟没更新 → 判为硬杀残留，可接管

function gitDir() {
  const r = spawnSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' });
  const out = (r.stdout ?? '').trim();
  return r.status === 0 && out ? out : '.git';
}

const LOCK_PATH = path.join(gitDir(), 'concertoai-agent.lock');

function readLock() {
  let raw;
  try {
    raw = fs.readFileSync(LOCK_PATH, 'utf8');
  } catch {
    return { state: 'free', lock: null };
  }
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    // 损坏的锁：不能静默当成「空」，如实报，由人决定
    return { state: 'corrupt', lock: null, raw };
  }
  const age = Date.now() - new Date(lock.heartbeatAt ?? 0).getTime();
  return { state: Number.isFinite(age) && age < TTL_MS ? 'fresh' : 'stale', lock, ageMs: age };
}

function writeLock(owner) {
  const now = new Date().toISOString();
  const prev = readLock().lock;
  const body = {
    owner,
    pid: process.pid,
    host: os.hostname(),
    startedAt: prev && prev.owner === owner ? prev.startedAt : now,
    heartbeatAt: now,
    ttlMs: TTL_MS,
  };
  const tmp = `${LOCK_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, LOCK_PATH); // 原子替换，避免写一半被读到
  return body;
}

function fmt(lock, ageMs) {
  if (!lock) return '(无)';
  const ageMin = Number.isFinite(ageMs) ? Math.round(ageMs / 60000) : '?';
  return `owner=${lock.owner} pid=${lock.pid} host=${lock.host} 心跳 ${ageMin} 分钟前`;
}

function die(msg, code = 2) {
  console.error(`agent-lock: ${msg}`);
  process.exit(code);
}

const [, , cmd, ...rest] = process.argv;
const ownerIdx = rest.indexOf('--owner');
const owner = ownerIdx >= 0 ? rest[ownerIdx + 1] : process.env.CONCERTOAI_AGENT;

if (!cmd || !['status', 'claim', 'heartbeat', 'release'].includes(cmd)) {
  die('用法: node scripts/agent-lock.mjs <status|claim|heartbeat|release> [--owner <id>]');
}
if (cmd !== 'status' && !owner) {
  die(`${cmd} 需要 --owner <id> 或环境变量 CONCERTOAI_AGENT；请显式声明身份（AGENTS 第 30 条）`);
}

const cur = readLock();

switch (cmd) {
  case 'status': {
    if (cur.state === 'free') {
      console.log('agent-lock: 空闲（无锁）');
      process.exit(0);
    }
    if (cur.state === 'corrupt') {
      console.error(`agent-lock: 锁文件损坏，需人工检查并删除: ${LOCK_PATH}`);
      process.exit(1);
    }
    if (cur.state === 'stale') {
      console.log(`agent-lock: 残留锁（心跳已过期，可接管）—— ${fmt(cur.lock, cur.ageMs)}`);
      process.exit(0);
    }
    console.log(`agent-lock: 被持有 —— ${fmt(cur.lock, cur.ageMs)}`);
    process.exit(cur.lock.owner === owner ? 0 : 1);
  }

  case 'claim': {
    if (cur.state === 'corrupt') {
      die(`锁文件损坏，需人工检查并删除: ${LOCK_PATH}`, 2);
    }
    if (cur.state === 'fresh' && cur.lock.owner !== owner) {
      console.error(`agent-lock: 拒绝 claim —— 另一个实例正在写（${fmt(cur.lock, cur.ageMs)}）`);
      console.error('agent-lock: 按 AGENTS 第 22 条，停手报告；确认对方已死后可删除锁文件或等心跳过期。');
      process.exit(1);
    }
    const body = writeLock(owner);
    const took = cur.state === 'stale' ? `（接管了残留锁：${fmt(cur.lock, cur.ageMs)}）` : '';
    console.log(`agent-lock: 已持有 —— owner=${body.owner} pid=${body.pid}${took}`);
    process.exit(0);
  }

  case 'heartbeat': {
    if (cur.state === 'free') die('无锁可刷新，先 claim', 1);
    if (cur.state === 'corrupt') die(`锁文件损坏: ${LOCK_PATH}`, 2);
    if (cur.lock.owner !== owner) die(`锁不属于 ${owner}（当前 owner=${cur.lock.owner}）`, 1);
    const body = writeLock(owner);
    console.log(`agent-lock: 心跳已更新 —— ${body.heartbeatAt}`);
    process.exit(0);
  }

  case 'release': {
    if (cur.state === 'free') {
      console.log('agent-lock: 无锁（幂等，无需释放）');
      process.exit(0);
    }
    if (cur.state === 'corrupt') die(`锁文件损坏，需人工删除: ${LOCK_PATH}`, 2);
    if (cur.lock.owner !== owner) die(`锁不属于 ${owner}（当前 owner=${cur.lock.owner}），不代删`, 1);
    fs.rmSync(LOCK_PATH, { force: true });
    console.log('agent-lock: 已释放');
    process.exit(0);
  }
}
