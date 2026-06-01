function formatTimestamp(date = new Date()) {
    const pad = n => String(n).padStart(2, '0')
    return `${pad(date.getMonth() + 1)}${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function prefixArgs(args) {
    return [`[${formatTimestamp()}]`, ...args]
}

function log(...args) {
    console.log(...prefixArgs(args))
}

function warn(...args) {
    console.warn(...prefixArgs(args))
}

function error(...args) {
    console.error(...prefixArgs(args))
}

/** 给 console.log/warn/error 自动加时间戳 */
function installLogTimestamp() {
    if (installLogTimestamp.installed) return
    installLogTimestamp.installed = true

    for (const method of ['log', 'warn', 'error']) {
        const original = console[method].bind(console)
        console[method] = (...args) => original(...prefixArgs(args))
    }
}

installLogTimestamp.installed = false

module.exports = { formatTimestamp, log, warn, error, installLogTimestamp }
