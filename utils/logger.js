/**
 * 滚动文件日志 + 控制台分流。
 *
 * - 所有 console.* 输出改写入 logs/<name>-YYYY-MM-DD.log（按天滚动，行首带系统时间戳）
 * - 控制台只回显重要信息：
 *     · logImportant(...) 显式标记的重要事件
 *     · 文本含 [告警]/[警告] 的行（既有告警点自动获得控制台可见性，无需改动）
 *     · console.warn / console.error 一律回显
 * - 超过保留期（默认 7 天）的日志文件在启动和跨天滚动时自动删除
 * - 未捕获异常 / 未处理的 Promise 拒绝也会写盘，避免现场丢失
 */
const fs = require('fs')
const path = require('path')
const util = require('util')

/** 命中即回显控制台的内容特征（既有 [告警]/[警告] 日志点） */
const ECHO_PATTERN = /\[告警\]|\[警告\]|告警:/

class RollingFileLogger {
    constructor(opts = {}) {
        this.name = opts.name || 'bot'
        // logger.js 位于 <项目根>/utils/ → 退一层即项目根（退两层会跑出项目！）
        this.dir = opts.dir || path.join(__dirname, '..', 'logs')
        this.retentionDays = opts.retentionDays ?? 7
        this._now = opts.now || (() => new Date())
        this.currentFile = null
        fs.mkdirSync(this.dir, { recursive: true })
        this._purgeOld()
    }

    ts(d = this._now()) {
        const p = n => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
            `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
    }

    _fileFor(d) {
        const p = n => String(n).padStart(2, '0')
        return path.join(this.dir,
            `${this.name}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`)
    }

    write(level, text) {
        try {
            const now = this._now()
            const file = this._fileFor(now)
            if (file !== this.currentFile) {
                fs.mkdirSync(this.dir, { recursive: true })
                this._purgeOld(now)
                this.currentFile = file
            }
            fs.appendFileSync(file, `[${this.ts(now)}] [${level}] ${text}\n`)
        } catch (e) {
            // 日志系统自身故障不能拖垮机器人：退回原始终端输出
            try { process.stderr.write(`[日志写入失败] ${e.message}\n`) } catch (_) { /* ignore */ }
        }
    }

    /** 删除超过保留期的本前缀日志文件（按文件名里的日期判断） */
    _purgeOld(now = this._now()) {
        try {
            const cutoff = now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000
            const prefix = this.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const re = new RegExp(`^${prefix}-(\\d{4})-(\\d{2})-(\\d{2})\\.log$`)
            for (const f of fs.readdirSync(this.dir)) {
                const m = f.match(re)
                if (!m) continue
                const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
                if (d.getTime() < cutoff) {
                    try { fs.unlinkSync(path.join(this.dir, f)) } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { /* 目录不可读等：忽略 */ }
    }
}

let _instance = null
let _important = null

const fmt = args => (args.length === 1 && typeof args[0] === 'string')
    ? args[0]
    : util.format(...args)

/** 初始化（每进程一次）：接管 console.*，返回 logger 实例 */
function initLogger(opts = {}) {
    if (_instance) return _instance
    const logger = new RollingFileLogger(opts)
    const orig = {
        log: console.log, info: console.info, warn: console.warn, error: console.error
    }

    console.log = (...args) => {
        const text = fmt(args)
        const t = logger.ts()
        logger.write('INFO', text)
        if (ECHO_PATTERN.test(text)) orig.log(`[${t}] ${text}`)
    }
    console.info = console.log
    console.warn = (...args) => {
        const text = fmt(args)
        const t = logger.ts()
        logger.write('WARN', text)
        orig.warn(`[${t}] [WARN] ${text}`)
    }
    console.error = (...args) => {
        const text = fmt(args)
        const t = logger.ts()
        logger.write('ERROR', text)
        orig.error(`[${t}] [ERROR] ${text}`)
    }

    _important = (...args) => {
        const text = fmt(args)
        const t = logger.ts()
        logger.write('IMPORTANT', text)
        orig.log(`[${t}] ${text}`)
    }

    // 进程级兜底：未捕获异常写盘后退出；未处理的 Promise 拒绝只记不退
    process.on('uncaughtException', (err) => {
        try {
            logger.write('ERROR', `未捕获异常: ${err && err.stack || err}`)
            _important(`[严重] 未捕获异常，进程退出: ${(err && err.message) || err}`)
        } catch (_) { /* ignore */ }
        process.exit(1)
    })
    process.on('unhandledRejection', (reason) => {
        try {
            logger.write('ERROR', `未处理的 Promise 拒绝: ${(reason && reason.stack) || reason}`)
        } catch (_) { /* ignore */ }
    })

    _instance = logger
    return logger
}

/** 重要信息：写文件 + 回显控制台 */
function logImportant(...args) {
    if (_important) _important(...args)
}

module.exports = { initLogger, logImportant, RollingFileLogger }
