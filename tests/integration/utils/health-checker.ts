import http from 'node:http';
import WebSocket from 'ws';
import { TestConfig } from './test-config';

const REQUEST_TIMEOUT_MS = 5000;

function httpGet(url: string): Promise<{ ok: boolean; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({ ok: response.statusCode === 200, body });
      });
    });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('timeout'));
    });
    request.on('error', reject);
  });
}

export class HealthChecker {
  static async checkWebSocketServer(): Promise<boolean> {
    try {
      const { ok, body } = await httpGet(`${TestConfig.SERVER_URL}/health`);
      if (!ok) {
        console.error('WebSocket server health check failed: non-200 response');
        return false;
      }

      const health = JSON.parse(body);
      console.log('✅ WebSocket server healthy:', health);
      return true;
    } catch (error) {
      console.error('❌ WebSocket server health check failed:', error);
      return false;
    }
  }

  static async checkViteServer(): Promise<boolean> {
    try {
      const { ok, body } = await httpGet(TestConfig.GAME_URL);
      if (!ok) {
        console.error('Vite server health check failed: non-200 response');
        return false;
      }

      if (!body.includes('GeoRoids') && !body.includes('@vite/client') && !body.includes('eventLoop')) {
        console.error('Vite server responded but content seems incorrect');
        return false;
      }

      console.log('✅ Vite dev server healthy');
      return true;
    } catch (error) {
      console.error('❌ Vite dev server health check failed:', error);
      return false;
    }
  }

  static async checkWebSocketGameplayEndpoint(): Promise<boolean> {
    return new Promise((resolve) => {
      const wsUrl = TestConfig.SERVER_URL.replace(/^http/, 'ws') + '/ws';
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        ws.close();
        console.error(`❌ WebSocket gameplay probe timed out after ${REQUEST_TIMEOUT_MS}ms`);
        resolve(false);
      }, REQUEST_TIMEOUT_MS);

      ws.on('open', () => {
        clearTimeout(timeout);
        ws.close();
        console.log('✅ WebSocket gameplay endpoint reachable');
        resolve(true);
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        console.error('❌ WebSocket gameplay probe failed');
        resolve(false);
      });
    });
  }

  static async checkAllServers(): Promise<void> {
    console.log('🔍 Checking server health...');

    const deadline = Date.now() + 30_000;
    let wsHealthy = false;
    let viteHealthy = false;
    let wsEndpointHealthy = false;

    while (Date.now() < deadline) {
      [wsHealthy, viteHealthy, wsEndpointHealthy] = await Promise.all([
        this.checkWebSocketServer(),
        this.checkViteServer(),
        this.checkWebSocketGameplayEndpoint(),
      ]);
      if (wsHealthy && viteHealthy && wsEndpointHealthy) {
        console.log('🎯 All servers are healthy!');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!wsHealthy || !viteHealthy || !wsEndpointHealthy) {
      const errors = [];
      if (!wsHealthy) errors.push('WebSocket server not running');
      if (!viteHealthy) errors.push('Vite dev server not running');
      if (!wsEndpointHealthy) errors.push('WebSocket /ws endpoint not reachable');

      throw new Error(
        `Required servers not running:\n` +
          `- WebSocket server (${TestConfig.SERVER_URL}): ${wsHealthy ? '✅' : '❌'}\n` +
          `- Vite dev server (${TestConfig.GAME_URL}): ${viteHealthy ? '✅' : '❌'}\n` +
          `- WebSocket /ws endpoint: ${wsEndpointHealthy ? '✅' : '❌'}\n\n` +
          `Run this scenario through: ./scripts/test-runner.sh <test-path>\n` +
          `Errors: ${errors.join(', ')}`
      );
    }
  }
}
