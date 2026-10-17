/**
 * phone-proxy-supervisor — 保活壳：崩了自动重启，重复启动让位给已在跑的实例。
 *
 * 判活方式：先看 51130 端口是否已有人监听。已有 → 说明别的实例活着，本壳退出。
 * 子进程意外退出 → 3 秒后重新拉起，并计数告警（连续失败会写日志，不静默停摆）。
 */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROXY = path.join(HERE, 'phone-proxy.mjs')
const PORT = 51130
const SUPERVISOR_LOG = path.join(HERE, 'logs', 'supervisor.log')

function supervisorLog(line) {
  const text = `[supervisor ${new Date().toISOString()}] ${line}`
  try {
    fs.mkdirSync(path.dirname(SUPERVISOR_LOG), { recursive: true })
    fs.appendFileSync(SUPERVISOR_LOG, text + '\n', 'utf8')
    console.log(text)
  } catch {
    // 日志失败不影响保活主流程
  }
}

function portTaken() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: PORT })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1500)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

if (await portTaken()) {
  supervisorLog(`port ${PORT} already served by a live instance; supervisor exiting`)
  process.exit(0)
}

let child = null
let consecutiveFastFailures = 0

function start() {
  const startedAt = Date.now()
  child = spawn(process.execPath, [PROXY], { stdio: 'inherit', cwd: HERE, windowsHide: true })
  child.on('exit', (code, signal) => {
    const livedMs = Date.now() - startedAt
    if (code === 0 && signal === null) {
      supervisorLog('proxy exited cleanly (EADDRINUSE takeover); supervisor stopping')
      process.exit(0)
      return
    }
    if (livedMs < 5000) {
      consecutiveFastFailures += 1
      supervisorLog(`proxy died after ${livedMs}ms (code=${String(code)} signal=${String(signal)}), consecutive fast failures=${consecutiveFastFailures}`)
      if (consecutiveFastFailures >= 5) {
        supervisorLog('too many fast failures; giving up so the watchdog can see the gap')
        process.exit(1)
      }
    } else {
      consecutiveFastFailures = 0
      supervisorLog(`proxy exited (code=${String(code)} signal=${String(signal)}); restarting in 3s`)
    }
    setTimeout(start, 3000)
  })
}

start()

process.on('SIGINT', () => {
  child?.kill()
  process.exit(0)
})
