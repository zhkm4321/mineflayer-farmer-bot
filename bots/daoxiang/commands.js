/**
 * 私聊命令解析与私聊格式识别。
 *
 * 【背景】mineflayer 的 whisper 事件不是协议层事件，而是用两条英文正则从
 * 渲染后的聊天文本里匹配出来的（chat.js addDefaultPatterns）：
 *   "Steve whispers to you: xxx" / "[Steve -> DaoXiang] xxx"
 * 服务器在 Via 协议转译后面时，/msg 可能以其他渲染格式（中文原版、箭头变体）
 * 的系统文本下发 —— 英文正则匹配不上，whisper 事件就永远不触发。
 * 这里补充常见格式；EXTRA_WHISPER_PATTERNS 用 deprecated 模式注册，
 * 与默认模式一样直接 emit('whisper', 用户名, 消息, ...)。
 */

/** 可选的称呼前缀（"/msg daoxiang daoxiang stop" 形式时剥掉） */
const PREFIX_ALIASES = ['daoxiang', '稻香']

/**
 * 解析私聊命令。同时接受两种形式：
 *   "daoxiang stop"（带前缀）与 "stop"（裸命令，/msg daoxiang stop 的形式）
 * @returns {'stop'|'start'|'status'|null}
 */
function parseWhisperCommand(text) {
    if (typeof text !== 'string') return null
    const msg = text.trim().toLowerCase()
    if (!msg) return null
    let tokens = msg.split(/\s+/)
    if (tokens.length > 1 && PREFIX_ALIASES.includes(tokens[0])) {
        tokens = tokens.slice(1)
    }
    switch (tokens[0]) {
        case 'stop': case '停': return 'stop'
        case 'start': case '开始': return 'start'
        case 'status': case '状态': return 'status'
        default: return null
    }
}

/**
 * 补充的私聊渲染格式（捕获组 1=发送者，组 2=消息正文）。
 * 与默认英文正则可能重叠（如同时匹配 "[A -> B] x"），handler 层做 3s 去重。
 */
const EXTRA_WHISPER_PATTERNS = [
    // 中文原版 /msg：Steve 悄悄地对你说：xxx（地/您 可选，全角半角冒号都认）
    /^(.{1,32}?)\s*悄悄(?:地)?对(?:你|您)说\s*[：:]\s*(.*)$/,
    // 方括号箭头变体：[Steve -> 你] / [Steve → DaoXiang] / [Steve => DaoXiang] xxx
    // 目标名不限于 \w+（默认正则只认英文目标名，中文目标名会漏）
    /^\[(.{1,32}?)\s*(?:->|→|=>|≫)\s*[^\]]*\]\s*(.*)$/
]

module.exports = { parseWhisperCommand, EXTRA_WHISPER_PATTERNS, PREFIX_ALIASES }
