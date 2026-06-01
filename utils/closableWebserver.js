const path = require('path')
const express = require('express')
const http = require('http')
const socket_io = require('socket.io')
const { StateMachineWebserver } = require('mineflayer-statemachine')

class ClosableWebserver extends StateMachineWebserver {
    startServer() {
        if (this.serverRunning) {
            throw new Error('Server already running!')
        }
        this.serverRunning = true
        const app = express()
        const publicFolder = path.join(__dirname, '..', 'node_modules', 'mineflayer-statemachine', 'web')
        app.use('/web', express.static(publicFolder))
        app.get('/', (req, res) => res.sendFile(path.join(publicFolder, 'index.html')))
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
