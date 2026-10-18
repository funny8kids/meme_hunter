#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from 'node:fs';

const PID = 'data/supervisor.pid';
if (!existsSync(PID)) {
  console.log('supervisor 未运行');
  process.exit(0);
}
const pid = Number(readFileSync(PID, 'utf8').trim());
try {
  process.kill(pid, 'SIGTERM');
  console.log(`已发送 SIGTERM 给 supervisor pid=${pid}`);
} catch {
  console.log(`supervisor pid=${pid} 不存在，清理 pid 文件`);
}
setTimeout(() => {
  try { rmSync(PID); } catch { /* ignore */ }
}, 4000);
