export function renderStatusPage(diagnosticsEnabled: boolean): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>WebSocket Status - GeoAsteroids</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #1a1a1a; color: #fff; }
        .container { max-width: 1200px; margin: 0 auto; }
        .log { overflow-wrap: anywhere; }
        .section { background: #2a2a2a; padding: 20px; margin: 20px 0; border-radius: 8px; }
        .status { padding: 10px; border-radius: 4px; margin: 10px 0; }
        .connected { background: #2d5a2d; }
        .disconnected { background: #5a2d2d; }
        .connecting { background: #5a5a2d; }
        .error { background: #8b0000; }
        .log { background: #333; padding: 8px; margin: 5px 0; border-radius: 4px; font-family: monospace; font-size: 12px; }
        .log.error { border-left: 4px solid #ff4444; }
        .log.info { border-left: 4px solid #44ff44; }
        .log.debug { border-left: 4px solid #4444ff; }
        .log.warn { border-left: 4px solid #ffff44; }
        button { background: #4CAF50; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; margin: 5px; }
        button:hover { background: #45a049; }
        button:disabled { background: #666; cursor: not-allowed; }
        .controls { margin: 20px 0; }
        .connection-info { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .metric { background: #333; padding: 15px; border-radius: 4px; text-align: center; }
        .metric-value { font-size: 24px; font-weight: bold; }
        .metric-value.connected { color: #4CAF50; }
        .metric-value.disconnected { color: #ff4444; }
        .metric-value.connecting { color: #ffff44; }
        .metric-value.error { color: #ff4444; }
        .metric-label { font-size: 12px; color: #aaa; margin-top: 5px; }
        .overall-status { margin: 20px 0; text-align: center; }
        .status-indicator {
            display: inline-flex;
            align-items: center;
            padding: 15px 25px;
            border-radius: 8px;
            font-size: 18px;
            font-weight: bold;
            transition: all 0.3s ease;
        }
        .status-indicator.connected {
            background: #2d5a2d;
            color: #4CAF50;
            box-shadow: 0 4px 15px rgba(76, 175, 80, 0.3);
        }
        .status-indicator.disconnected {
            background: #5a2d2d;
            color: #ff4444;
        }
        .status-indicator.partial {
            background: #5a5a2d;
            color: #ffff44;
        }
        .status-icon { margin-right: 10px; font-size: 24px; }
        @media (max-width: 600px) { .connection-info { grid-template-columns: 1fr; } }
    </style>
</head>
<body>
    <div class="container">
        <h1>&#128295; WebSocket Status Console</h1>

        <div class="section">
            <h2>Connection Status</h2>
            <div class="connection-info">
                <div class="metric">
                    <div class="metric-value" id="gameStatus">Disconnected</div>
                    <div class="metric-label">Game WebSocket</div>
                </div>
                <div class="metric">
                    <div class="metric-value" id="logStatus">Disconnected</div>
                    <div class="metric-label">Log WebSocket</div>
                </div>
            </div>

            <div id="overallStatus" class="overall-status">
                <div class="status-indicator disconnected">
                    <span class="status-icon">❌</span>
                    <span class="status-text">Both WebSockets Disconnected</span>
                </div>
            </div>

            <div class="controls">
                <button onclick="connectGame()" id="connectGameBtn">Connect Game</button>
                <button onclick="disconnectGame()" id="disconnectGameBtn" disabled>Disconnect Game</button>
                <button onclick="connectLogs()" id="connectLogsBtn">Connect Logs</button>
                <button onclick="disconnectLogs()" id="disconnectLogsBtn" disabled>Disconnect Logs</button>
                <button onclick="testAllConnections()" id="testAllBtn">Test All Connections</button>
                <button onclick="clearLogs()">Clear Logs</button>
                <button onclick="testLogMessage()" id="testLogBtn" disabled>Test Log Message</button>
                <br><br>
                ${diagnosticsEnabled ? '<button onclick="sendServerLog()" id="serverLogBtn">Send Server Log</button>' : '<span>Server log diagnostics are available in development only.</span>'}
                <button onclick="sendClientLog()" id="clientLogBtn">Send Client Log</button>
            </div>
        </div>

        <div class="section">
            <h2>Server Health</h2>
            <div id="serverHealth">
                <div class="log info">Checking server health...</div>
            </div>
        </div>

        <div class="section">
            <h2>Logging Health</h2>
            <div id="loggingHealth" aria-live="polite">Checking logging diagnostics...</div>
        </div>

        <div class="section">
            <h2>Message Log</h2>
            <div id="messageLog"></div>
        </div>

        <div class="section">
            <h2>Connection Details</h2>
            <div id="connectionDetails">
                <div class="log info">Connection details will appear here</div>
            </div>
        </div>
    </div>

    <script>
        // Compute endpoints from current page location
        const wsBase = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host;

        const STATUS_SOCKET_CONNECT_TIMEOUT_MS = 5000;
        const socketDeadlines = new WeakMap();
        let gameWs = null;
        let logWs = null;
        let messageCount = 0;

        function addLog(message, level = 'info') {
            const logDiv = document.createElement('div');
            logDiv.className = \`log \${level}\`;
            logDiv.textContent = \`[\${new Date().toISOString()}] \${message}\`;
            document.getElementById('messageLog').appendChild(logDiv);
            messageCount++;

            // Keep only last 100 messages
            if (messageCount > 100) {
                document.getElementById('messageLog').removeChild(
                    document.getElementById('messageLog').firstChild
                );
                messageCount--;
            }
        }

        function socketErrorMessage(error) {
            return error && typeof error.message === 'string' && error.message ? error.message : 'unknown WebSocket error';
        }

        function closeStatusSocket(socket, label) {
            if (!socket) return;
            clearSocketDeadline(socket);
            if (socket.readyState === WebSocket.CLOSED) return;
            try {
                socket.close();
            } catch (error) {
                addLog(\`\${label} WebSocket could not close after failure: \${socketErrorMessage(error)}\`, 'error');
            }
        }

        function clearSocketDeadline(socket) {
            window.clearTimeout(socketDeadlines.get(socket));
            socketDeadlines.delete(socket);
        }

        function createStatusSocket(url, label, handlers) {
            let socket;
            try {
                socket = new WebSocket(url);
            } catch (error) {
                handlers.onFailure(null, \`could not create connection: \${socketErrorMessage(error)}\`);
                return null;
            }

            let opened = false;
            const deadline = window.setTimeout(function() {
                if (socket.readyState !== WebSocket.CONNECTING) return;
                clearSocketDeadline(socket);
                try {
                    handlers.onFailure(socket, 'connection timed out after 5 seconds; retry is available');
                } finally {
                    closeStatusSocket(socket, label);
                }
            }, STATUS_SOCKET_CONNECT_TIMEOUT_MS);
            socketDeadlines.set(socket, deadline);

            socket.onopen = function(event) {
                clearSocketDeadline(socket);
                opened = true;
                if (handlers.onopen) handlers.onopen(socket, event);
            };

            socket.onclose = function(event) {
                clearSocketDeadline(socket);
                if (handlers.onclose) handlers.onclose(socket, event, opened);
            };

            socket.onerror = function(error) {
                clearSocketDeadline(socket);
                if (handlers.onerror) handlers.onerror(socket, error);
            };

            socket.onmessage = function(event) {
                if (handlers.onmessage) handlers.onmessage(socket, event);
            };

            return socket;
        }

        function updateConnectionDetails() {
            const gameStatus = gameWs ? gameWs.readyState : WebSocket.CLOSED;
            const logStatus = logWs ? logWs.readyState : WebSocket.CLOSED;

            let overallStatus = 'disconnected';
            if (gameStatus === WebSocket.OPEN && logStatus === WebSocket.OPEN) {
                overallStatus = 'connected';
            } else if (gameStatus === WebSocket.OPEN || logStatus === WebSocket.OPEN) {
                overallStatus = 'partial';
            }

            // Update status indicators
            document.getElementById('gameStatus').textContent =
                gameStatus === WebSocket.OPEN ? 'Connected' :
                gameStatus === WebSocket.CONNECTING ? 'Connecting' : 'Disconnected';
            document.getElementById('gameStatus').className =
                \`metric-value \${gameStatus === WebSocket.OPEN ? 'connected' :
                  gameStatus === WebSocket.CONNECTING ? 'connecting' : 'disconnected'}\`;

            document.getElementById('logStatus').textContent =
                logStatus === WebSocket.OPEN ? 'Connected' :
                logStatus === WebSocket.CONNECTING ? 'Connecting' : 'Disconnected';
            document.getElementById('logStatus').className =
                \`metric-value \${logStatus === WebSocket.OPEN ? 'connected' :
                  logStatus === WebSocket.CONNECTING ? 'connecting' : 'disconnected'}\`;

            // Update overall status
            const overallElement = document.getElementById('overallStatus');
            overallElement.innerHTML = \`
                <div class="status-indicator \${overallStatus}">
                    <span class="status-icon">\${overallStatus === 'connected' ? '✅' :
                                               overallStatus === 'partial' ? '⚠️' : '❌'}</span>
                    <span class="status-text">\${overallStatus === 'connected' ? 'Both WebSockets Connected' :
                                               overallStatus === 'partial' ? 'One WebSocket Connected' : 'Both WebSockets Disconnected'}</span>
                </div>
            \`;

            // Update button states
            const gameActive = gameStatus === WebSocket.OPEN || gameStatus === WebSocket.CONNECTING;
            const logActive = logStatus === WebSocket.OPEN || logStatus === WebSocket.CONNECTING;
            document.getElementById('connectGameBtn').disabled = gameActive;
            document.getElementById('disconnectGameBtn').disabled = !gameActive;
            document.getElementById('connectLogsBtn').disabled = logActive;
            document.getElementById('disconnectLogsBtn').disabled = !logActive;
            document.getElementById('testLogBtn').disabled = logStatus !== WebSocket.OPEN;

            // Update connection details
            document.getElementById('connectionDetails').innerHTML = \`
                <div class="log info">Game WebSocket: \${gameWs ? \`\${wsBase}/ws (\${gameWs.readyState === WebSocket.OPEN ? 'OPEN' :
                                                                                    gameWs.readyState === WebSocket.CONNECTING ? 'CONNECTING' :
                                                                                    gameWs.readyState === WebSocket.CLOSING ? 'CLOSING' : 'CLOSED'})\` : 'Not connected'}</div>
                <div class="log info">Log WebSocket: \${logWs ? \`\${wsBase}/logs (\${logWs.readyState === WebSocket.OPEN ? 'OPEN' :
                                                                                   logWs.readyState === WebSocket.CONNECTING ? 'CONNECTING' :
                                                                                   logWs.readyState === WebSocket.CLOSING ? 'CLOSING' : 'CLOSED'})\` : 'Not connected'}</div>
            \`;
        }

        function connectGame() {
            if (gameWs && (gameWs.readyState === WebSocket.OPEN || gameWs.readyState === WebSocket.CONNECTING)) {
                addLog(\`Game WebSocket \${gameWs.readyState === WebSocket.OPEN ? 'already connected' : 'is already connecting'}\`, 'warn');
                return;
            }
            if (gameWs) {
                const previous = gameWs;
                gameWs = null;
                closeStatusSocket(previous, 'Game');
            }

            addLog('Connecting to game WebSocket...', 'info');
            gameWs = createStatusSocket(\`\${wsBase}/ws?asteroidInteractions=1\`, 'Game', {
                onopen: function(socket) {
                    if (gameWs !== socket) return;
                    addLog('Game WebSocket connected', 'info');
                    updateConnectionDetails();
                },
                onclose: function(socket, event, opened) {
                    if (gameWs !== socket) return;
                    gameWs = null;
                    if (!opened) {
                        addLog(\`Game WebSocket failed: closed before opening (\${event.code} - \${event.reason || 'no reason provided'}); retry is available\`, 'error');
                    } else {
                        addLog(\`Game WebSocket disconnected: \${event.code} - \${event.reason}\`, 'warn');
                    }
                    updateConnectionDetails();
                },
                onerror: function(socket, error) {
                    if (gameWs !== socket) return;
                    gameWs = null;
                    addLog(\`Game WebSocket failed: connection failed: \${socketErrorMessage(error)}; retry is available\`, 'error');
                    updateConnectionDetails();
                    closeStatusSocket(socket, 'Game');
                },
                onmessage: function(socket, event) {
                    if (gameWs === socket) addLog(\`Game message received: \${event.data}\`, 'info');
                },
                onFailure: function(socket, reason) {
                    if (socket !== null && gameWs !== socket) return;
                    gameWs = null;
                    addLog(\`Game WebSocket failed: \${reason}\`, 'error');
                    updateConnectionDetails();
                }
            });
            updateConnectionDetails();
        }

        function disconnectGame() {
            const socket = gameWs;
            gameWs = null;
            updateConnectionDetails();
            if (socket) {
                addLog('Game WebSocket disconnected by operator', 'info');
                closeStatusSocket(socket, 'Game');
            }
        }

        function connectLogs() {
            if (logWs && (logWs.readyState === WebSocket.OPEN || logWs.readyState === WebSocket.CONNECTING)) {
                addLog(\`Log WebSocket \${logWs.readyState === WebSocket.OPEN ? 'already connected' : 'is already connecting'}\`, 'warn');
                return;
            }
            if (logWs) {
                const previous = logWs;
                logWs = null;
                closeStatusSocket(previous, 'Log');
            }

            addLog('Connecting to log WebSocket...', 'info');
            logWs = createStatusSocket(\`\${wsBase}/logs\`, 'Log', {
                onopen: function(socket) {
                    if (logWs !== socket) return;
                    addLog('Log WebSocket connected', 'info');
                    updateConnectionDetails();
                },
                onclose: function(socket, event, opened) {
                    if (logWs !== socket) return;
                    logWs = null;
                    if (!opened) {
                        addLog(\`Log WebSocket failed: closed before opening (\${event.code} - \${event.reason || 'no reason provided'}); retry is available\`, 'error');
                    } else {
                        addLog(\`Log WebSocket disconnected: \${event.code} - \${event.reason}\`, 'warn');
                    }
                    updateConnectionDetails();
                },
                onerror: function(socket, error) {
                    if (logWs !== socket) return;
                    logWs = null;
                    addLog(\`Log WebSocket failed: connection failed: \${socketErrorMessage(error)}; retry is available\`, 'error');
                    updateConnectionDetails();
                    closeStatusSocket(socket, 'Log');
                },
                onmessage: function(socket, event) {
                    if (logWs === socket) addLog(\`Log message received: \${event.data}\`, 'info');
                },
                onFailure: function(socket, reason) {
                    if (socket !== null && logWs !== socket) return;
                    logWs = null;
                    addLog(\`Log WebSocket failed: \${reason}\`, 'error');
                    updateConnectionDetails();
                }
            });
            updateConnectionDetails();
        }

        function disconnectLogs() {
            const socket = logWs;
            logWs = null;
            updateConnectionDetails();
            if (socket) {
                addLog('Log WebSocket disconnected by operator', 'info');
                closeStatusSocket(socket, 'Log');
            }
        }

        function testLogMessage() {
            const socket = logWs;
            if (!socket || socket.readyState !== WebSocket.OPEN) return;

            const testMessage = {
                type: 'clientLog',
                timestamp: Date.now(),
                data: {
                    sessionId: 'debug-session-' + Date.now(),
                    level: 'INFO',
                    line: \`[\${new Date().toISOString()}] INFO Test message from debug console\`,
                    message: 'Test message from debug console',
                    userAgent: navigator.userAgent,
                    pageUrl: location.href
                }
            };

            try {
                socket.send(JSON.stringify(testMessage));
                addLog(\`Test log message sent: \${JSON.stringify(testMessage)}\`, 'info');
            } catch (error) {
                if (logWs !== socket) return;
                logWs = null;
                addLog(\`Log WebSocket failed: failed to send test log message: \${socketErrorMessage(error)}; retry is available\`, 'error');
                updateConnectionDetails();
                closeStatusSocket(socket, 'Log');
            }
        }

        function testAllConnections() {
            addLog('Testing all WebSocket connections...', 'info');

            // Disconnect existing connections first
            if (gameWs) {
                const socket = gameWs;
                gameWs = null;
                closeStatusSocket(socket, 'Game');
            }
            if (logWs) {
                const socket = logWs;
                logWs = null;
                closeStatusSocket(socket, 'Log');
            }
            updateConnectionDetails();

            // Wait a moment, then connect both
            setTimeout(() => {
                connectGame();
                setTimeout(() => {
                    connectLogs();
                }, 500);
            }, 200);
        }

        function clearLogs() {
            document.getElementById('messageLog').innerHTML = '';
            messageCount = 0;
        }

        async function requestJson(path, options = {}) {
            const response = await fetch(path, { ...options, signal: AbortSignal.timeout(5000) });
            if (!response.ok) {
                throw new Error('HTTP ' + response.status + ' from ' + path);
            }
            return response.json();
        }

        async function checkServerHealth() {
            const panel = document.getElementById('serverHealth');
            const loggingPanel = document.getElementById('loggingHealth');
            try {
                const data = await requestJson('/health');
                if (!data || data.status !== 'healthy' ||
                    !Number.isSafeInteger(data.players) || data.players < 0 ||
                    !Number.isFinite(data.uptime) || data.uptime < 0 ||
                    typeof data.timestamp !== 'string' || !Number.isFinite(Date.parse(data.timestamp))) {
                    throw new Error('Invalid health response');
                }
                panel.className = '';
                panel.replaceChildren();
                for (const message of ['✅ Server is healthy', 'Players: ' + data.players,
                    'Uptime: ' + data.uptime.toFixed(2) + 's', 'Timestamp: ' + data.timestamp]) {
                    const row = document.createElement('div');
                    row.className = 'log info';
                    row.textContent = message;
                    panel.appendChild(row);
                }
                renderLoggingHealth(data.logging);
            } catch (error) {
                panel.textContent = '❌ Server health check failed: ' + error.message;
                panel.className = 'error';
                addLog('Health check failed: ' + error.message, 'error');
                const unavailable = 'Logging diagnostics unavailable: health request failed.';
                if (loggingPanel.textContent !== unavailable) loggingPanel.textContent = unavailable;
                delete loggingPanel.dataset.signature;
                loggingPanel.className = 'error';
            }
        }

        function renderLoggingHealth(logging) {
            const panel = document.getElementById('loggingHealth');
            const ingress = logging && logging.clientIngress;
            const writer = logging && logging.serverWriter;
            const counts = logging && ingress && writer ? [logging.activeLogClients,
                ingress.queuedBytes, ingress.droppedRecords, ingress.writeErrors,
                ingress.invalid, ingress.rateLimited, ingress.clientReportedDroppedRecords,
                writer.queuedBytes, writer.droppedRecords, writer.writeErrors,
                writer.stdoutDroppedRecords, writer.stdoutWriteErrors] : [];
            if (counts.length !== 12 || counts.some(value => !Number.isSafeInteger(value) || value < 0)) {
                const unavailable = 'Logging diagnostics unavailable: invalid or missing counters.';
                if (panel.textContent !== unavailable) panel.textContent = unavailable;
                delete panel.dataset.signature;
                panel.className = 'error';
                return;
            }
            const losses = ingress.droppedRecords + writer.droppedRecords;
            const failures = ingress.writeErrors + writer.writeErrors;
            const rows = [
                ['Connected log clients: ' + logging.activeLogClients, 'info'],
                ['Queued bytes: client ' + ingress.queuedBytes + ', server ' + writer.queuedBytes, 'info'],
                ['Dropped file records since startup: ' + losses, losses ? 'warn' : 'info'],
                ['Browser-reported dropped records: ' + ingress.clientReportedDroppedRecords,
                    ingress.clientReportedDroppedRecords ? 'warn' : 'info'],
                ['File write errors since startup: ' + failures, failures ? 'warn' : 'info'],
                ['Standard-output records dropped: ' + writer.stdoutDroppedRecords,
                    writer.stdoutDroppedRecords ? 'warn' : 'info'],
                ['Standard-output write errors: ' + writer.stdoutWriteErrors,
                    writer.stdoutWriteErrors ? 'warn' : 'info'],
                ['Rejected client records: invalid ' + ingress.invalid + ', rate limited ' + ingress.rateLimited,
                    ingress.invalid || ingress.rateLimited ? 'warn' : 'info']
            ];
            const signature = JSON.stringify(rows);
            if (panel.dataset.signature === signature) return;
            panel.dataset.signature = signature;
            panel.className = '';
            panel.replaceChildren();
            for (const [message, level] of rows) {
                const row = document.createElement('div');
                row.className = 'log ' + level;
                row.textContent = message;
                panel.appendChild(row);
            }
        }

        async function sendServerLog() {
            const button = document.getElementById('serverLogBtn');
            const originalText = button.textContent;
            button.textContent = 'Sending...';
            button.disabled = true;
            try {
                const data = await requestJson('/test-server-log', { method: 'POST' });
                if (!data || data.status !== 'success' || typeof data.message !== 'string') {
                    throw new Error('Invalid log-write response');
                }
                addLog(data.message, 'info');
                button.textContent = '✅ Written';
            } catch (error) {
                addLog('Failed to write server log: ' + error.message, 'error');
                button.textContent = '❌ Failed';
            } finally {
                setTimeout(() => {
                    button.textContent = originalText;
                    button.disabled = false;
                }, 2000);
            }
        }

        function sendClientLog() {
            const button = document.getElementById('clientLogBtn');
            const originalText = button.textContent || 'Send Client Log';
            let finished = false;

            function failClientLog(reason) {
                if (finished) return false;
                finished = true;
                addLog(\`Failed to send log message: \${reason}\`, 'error');
                button.textContent = originalText;
                button.disabled = false;
                return true;
            }

            button.textContent = 'Sending...';
            button.disabled = true;

            createStatusSocket(\`\${wsBase}/logs\`, 'Client log', {
                onopen: function(socket) {
                    if (finished) return;
                    const testMessage = {
                        type: 'clientLog',
                        timestamp: Date.now(),
                        data: {
                            sessionId: 'status-page-test',
                            level: 'INFO',
                            line: '[Status Page Test] INFO Test client log from /status page',
                            message: 'Test client log from /status page - this should appear in client.log',
                            userAgent: navigator.userAgent,
                            pageUrl: location.href
                        }
                    };

                    try {
                        socket.send(JSON.stringify(testMessage));
                    } catch (error) {
                        if (failClientLog(\`send failed: \${socketErrorMessage(error)}; retry is available\`)) {
                            closeStatusSocket(socket, 'Client log');
                        }
                        return;
                    }

                    finished = true;
                    addLog('Client log sent directly to server via WebSocket', 'info');
                    button.textContent = 'Sent!';
                    setTimeout(() => {
                        button.textContent = originalText;
                        button.disabled = false;
                    }, 2000);
                    setTimeout(() => closeStatusSocket(socket, 'Client log'), 100);
                },
                onerror: function(socket, error) {
                    if (failClientLog(\`connection failed: \${socketErrorMessage(error)}; retry is available\`)) {
                        closeStatusSocket(socket, 'Client log');
                    }
                },
                onclose: function(socket, event, opened) {
                    if (!opened) {
                        failClientLog(\`closed before opening (\${event.code} - \${event.reason || 'no reason provided'}); retry is available\`);
                    }
                },
                onFailure: function(socket, reason) {
                    failClientLog(reason);
                }
            });
        }

        // Check server health every 5 seconds
        setInterval(checkServerHealth, 5000);
        checkServerHealth();

        // Initial connection details
        updateConnectionDetails();
    </script>
</body>
</html>
      `;
}
