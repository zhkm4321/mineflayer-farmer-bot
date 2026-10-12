const path = require('path')
const fs = require('fs')
const express = require('express')
const http = require('http')
const socket_io = require('socket.io')
const { StateMachineWebserver } = require('mineflayer-statemachine')

const statusPanel = `
<style>
#dao-status-panel{position:fixed;z-index:999999;top:14px;right:14px;width:min(350px,calc(100vw - 28px));max-height:calc(100vh - 28px);overflow:auto;box-sizing:border-box;padding:14px 16px;color:#edf4ff;background:rgba(13,21,34,.96);border:1px solid rgba(122,164,220,.4);border-radius:12px;box-shadow:0 10px 36px rgba(0,0,0,.42);font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;backdrop-filter:blur(10px)}
#dao-status-panel *{box-sizing:border-box}#dao-status-panel .ds-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;font-size:15px;font-weight:700}#dao-status-panel .ds-online{font-size:11px;color:#69df9a}#dao-status-panel .ds-offline{font-size:11px;color:#ff8d8d}
#dao-status-panel .ds-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}.ds-card{background:rgba(255,255,255,.06);padding:8px 10px;border-radius:8px}.ds-label{color:#aabbd2;font-size:11px}.ds-value{font-size:16px;font-weight:650;margin-top:2px}.ds-bar{height:5px;background:#263449;border-radius:9px;margin-top:6px;overflow:hidden}.ds-fill{height:100%;background:linear-gradient(90deg,#5c9cff,#63e0b0);border-radius:9px;transition:width .2s}.ds-food .ds-fill{background:linear-gradient(90deg,#f4b64d,#75d99b)}
#dao-status-panel .ds-state{color:#d9e7fa;padding:7px 9px;margin-bottom:10px;border-left:3px solid #6aa6ff;background:rgba(95,148,220,.1);border-radius:3px 7px 7px 3px;word-break:break-word}.ds-section{margin-top:10px}.ds-section h3{font-size:12px;color:#b8c9df;margin:0 0 6px}.ds-inventory{max-height:180px;overflow:auto;border-top:1px solid rgba(255,255,255,.1)}.ds-row{display:flex;justify-content:space-between;gap:10px;padding:4px 2px;border-bottom:1px solid rgba(255,255,255,.055)}.ds-row span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ds-count{font-variant-numeric:tabular-nums;color:#fff;font-weight:650}.ds-hoe{padding:7px 9px;background:rgba(211,166,91,.1);border:1px solid rgba(211,166,91,.23);border-radius:8px}.ds-hoe-row{display:flex;justify-content:space-between;gap:8px}.ds-durability{color:#eac98b;font-size:11px;margin-top:4px}.ds-foot{color:#7890aa;font-size:10px;margin-top:7px}.ds-hide{display:none!important}
#dao-status-toggle{border:0;background:#27364b;color:#dce9f9;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:11px}
</style>
<aside id="dao-status-panel" aria-label="DaoXiang 实时状态">
 <div class="ds-head"><span>🌾 稻香 · 实时状态</span><span><span id="ds-online" class="ds-offline">连接中</span> <button id="dao-status-toggle">收起</button></span></div>
 <div id="ds-content">
  <div class="ds-state" id="ds-state">等待数据…</div>
  <div class="ds-grid">
   <div class="ds-card"><div class="ds-label">生命值</div><div class="ds-value" id="ds-health">—</div><div class="ds-bar"><div class="ds-fill" id="ds-health-bar"></div></div></div>
   <div class="ds-card ds-food"><div class="ds-label">饥饿值</div><div class="ds-value" id="ds-food">—</div><div class="ds-bar"><div class="ds-fill" id="ds-food-bar"></div></div></div>
  </div>
  <div class="ds-grid"><div class="ds-card"><div class="ds-label">饱和度</div><div class="ds-value" id="ds-saturation">—</div></div><div class="ds-card"><div class="ds-label">坐标</div><div class="ds-value" id="ds-position" style="font-size:12px">—</div></div></div>
  <div class="ds-section"><h3>石锄 · <span id="ds-hoe-count">0</span> 把</h3><div class="ds-hoe" id="ds-hoe-items">背包中没有石锄</div></div>
  <div class="ds-section"><h3>背包物品</h3><div class="ds-inventory" id="ds-inventory"></div></div>
  <div class="ds-foot" id="ds-updated">等待更新</div>
 </div>
</aside>
<script>
(()=>{
 const q=id=>document.getElementById(id), content=q('ds-content'), toggle=q('dao-status-toggle');
 toggle.addEventListener('click',()=>{const hide=!content.classList.contains('ds-hide');content.classList.toggle('ds-hide',hide);toggle.textContent=hide?'展开':'收起'});
 const setText=(id,value)=>{q(id).textContent=value};
 const pct=(v,max)=>max>0?Math.max(0,Math.min(100,(v/max)*100)):0;
 function render(d){
  const online=q('ds-online');online.textContent=d.online?'在线':'离线';online.className=d.online?'ds-online':'ds-offline';
  setText('ds-state',d.state||'—');
  setText('ds-health',d.health==null?'—':d.health+'/'+d.maxHealth+'（'+(d.health/2).toFixed(1)+'❤）');
  q('ds-health-bar').style.width=pct(d.health,d.maxHealth)+'%';
  setText('ds-food',d.food==null?'—':d.food+'/'+d.maxFood);
  q('ds-food-bar').style.width=pct(d.food,d.maxFood)+'%';
  setText('ds-saturation',d.saturation==null?'—':Number(d.saturation).toFixed(1));
  setText('ds-position',d.position?d.position.x.toFixed(1)+', '+d.position.y.toFixed(1)+', '+d.position.z.toFixed(1):'—');
  setText('ds-hoe-count',String(d.hoe?.count??0));
  const hoeBox=q('ds-hoe-items');hoeBox.replaceChildren();
  if(!d.hoe?.items?.length){hoeBox.textContent='背包中没有石锄'}else{
   d.hoe.items.forEach(h=>{const row=document.createElement('div');row.className='ds-hoe-row';const name=document.createElement('span');name.textContent=(h.displayName||d.hoe.name)+(h.count>1?' ×'+h.count:'')+(h.slot==null?'':' · 槽位 '+h.slot);const dur=document.createElement('span');dur.textContent=h.durability?.remaining==null?'耐久未知':h.durability.remaining+'/'+h.durability.max;row.append(name,dur);hoeBox.append(row);if(h.durability?.percent!=null){const bar=document.createElement('div');bar.className='ds-bar';const fill=document.createElement('div');fill.className='ds-fill';fill.style.width=h.durability.percent+'%';bar.append(fill);hoeBox.append(bar)}})
  }
  const list=q('ds-inventory');list.replaceChildren();
  if(!d.inventory?.length){list.textContent='背包为空'}else d.inventory.forEach(item=>{const row=document.createElement('div');row.className='ds-row';const name=document.createElement('span');name.textContent=item.displayName||item.name;const count=document.createElement('span');count.className='ds-count';count.textContent='× '+item.count;row.append(name,count);list.append(row)});
  setText('ds-updated','每秒刷新 · '+new Date(d.updatedAt).toLocaleTimeString())
 }
 async function refresh(){try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);render(await r.json())}catch(e){const on=q('ds-online');on.textContent='数据暂不可用';on.className='ds-offline'}}
 refresh();setInterval(refresh,1000)
})();
</script>`

class ClosableWebserver extends StateMachineWebserver {
    constructor(bot, stateMachine, port, statusProvider = null) {
        super(bot, stateMachine, port)
        this.statusProvider = statusProvider
    }

    startServer() {
        if (this.serverRunning) {
            throw new Error('Server already running!')
        }
        this.serverRunning = true
        const app = express()
        const publicFolder = path.join(__dirname, '..', 'node_modules', 'mineflayer-statemachine', 'web')
        const indexFile = path.join(publicFolder, 'index.html')
        app.use('/web', express.static(publicFolder))
        if (this.statusProvider) {
            app.get('/api/status', (req, res) => {
                try {
                    res.set('Cache-Control', 'no-store')
                    res.json(this.statusProvider())
                } catch (e) {
                    res.status(500).json({ error: e.message })
                }
            })
            app.get('/', (req, res) => {
                fs.readFile(indexFile, 'utf8', (err, html) => {
                    if (err) return res.status(500).send(`无法读取状态机页面: ${err.message}`)
                    const bodyEnd = html.toLowerCase().lastIndexOf('</body>')
                    const injected = bodyEnd >= 0
                        ? `${html.slice(0, bodyEnd)}${statusPanel}${html.slice(bodyEnd)}`
                        : `${html}${statusPanel}`
                    res.type('html').send(injected)
                })
            })
        } else {
            app.get('/', (req, res) => res.sendFile(indexFile))
        }
        this.httpServer = http.createServer(app)
        this.io = socket_io(this.httpServer)
        this.io.on('connection', (socket) => this.onConnected(socket))
        this.httpServer.listen(this.port, () => this.onStarted())
    }

    stopServer(timeoutMs = 1500) {
        return new Promise((resolve) => {
            if (!this.httpServer) {
                resolve()
                return
            }

            let settled = false
            const finish = () => {
                if (settled) return
                settled = true
                this.serverRunning = false
                this.httpServer = null
                this.io = null
                resolve()
            }

            const timer = setTimeout(finish, timeoutMs)

            try {
                if (this.io) this.io.close()
            } catch (e) {}

            if (typeof this.httpServer.closeAllConnections === 'function') {
                this.httpServer.closeAllConnections()
            }

            this.httpServer.close(() => {
                clearTimeout(timer)
                finish()
            })
        })
    }
}

module.exports = { ClosableWebserver }
