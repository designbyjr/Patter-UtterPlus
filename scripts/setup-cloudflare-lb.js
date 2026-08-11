#!/usr/bin/env node

/**
 * setup-cloudflare-lb.js
 * 
 * Automates the creation of Cloudflare Load Balancer Monitors, Origin Pools, and Rules
 * for Patter Voice Agent Containers on Cloudflare.
 */

const https = require('https');

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '27e89563673d4bcd83625e2e12948bd4';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

if (!API_TOKEN) {
  console.error('\n❌ ERROR: CLOUDFLARE_API_TOKEN environment variable is missing.');
  console.error('Please set CLOUDFLARE_API_TOKEN with Load Balancer:Edit permissions to automate setup.\n');
  console.log('Example:');
  console.log('  export CLOUDFLARE_API_TOKEN="your_cloudflare_api_token"');
  console.log('  node scripts/setup-cloudflare-lb.js\n');
  process.exit(1);
}

function apiRequest(path, method, data) {
  return new Promise((resolve, reject) => {
    const payload = data ? JSON.stringify(data) : null;
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: `/client/v4${path}`,
      method: method,
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${body}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function setupLoadBalancer() {
  console.log('\n🚀 Setting up Cloudflare Load Balancer & Health Monitors for Patter Containers...\n');

  // 1. Create Health Monitor
  console.log('📡 Step 1: Creating Cloudflare Health Monitor (patter-container-monitor)...');
  const monitorPayload = {
    type: 'https',
    description: 'Patter Voice Container Health & Capacity Monitor',
    method: 'GET',
    path: '/capacity',
    expected_codes: '200',
    expected_body: '"status":"healthy"',
    interval: 15,
    timeout: 5,
    retries: 1,
    consecutive_up: 1,
    consecutive_down: 1,
  };

  const monitorRes = await apiRequest(`/accounts/${ACCOUNT_ID}/load_balancers/monitors`, 'POST', monitorPayload);
  if (!monitorRes.success) {
    console.error('❌ Failed to create Health Monitor:', monitorRes.errors);
    process.exit(1);
  }

  const monitorId = monitorRes.result.id;
  console.log(`✅ Health Monitor created successfully (ID: ${monitorId})\n`);

  // 2. Create Origin Pool
  console.log('🏊 Step 2: Creating Origin Pool (patter-primary-pool)...');
  const poolPayload = {
    name: 'patter-primary-pool',
    description: 'Patter Voice Infrastructure Primary Container Pool',
    monitor: monitorId,
    enabled: true,
    minimum_origins: 1,
    origins: [
      {
        name: 'patter-container-origin-1',
        address: 'patter-voice-agent.saipenflow.workers.dev',
        enabled: true,
        weight: 1,
      },
    ],
  };

  const poolRes = await apiRequest(`/accounts/${ACCOUNT_ID}/load_balancers/pools`, 'POST', poolPayload);
  if (!poolRes.success) {
    console.error('❌ Failed to create Origin Pool:', poolRes.errors);
    process.exit(1);
  }

  const poolId = poolRes.result.id;
  console.log(`✅ Origin Pool created successfully (ID: ${poolId})\n`);

  console.log('🎉 SUCCESS! Cloudflare Load Balancer Monitor & Pool are fully configured.');
  console.log(`- Account ID:  ${ACCOUNT_ID}`);
  console.log(`- Monitor ID:  ${monitorId}`);
  console.log(`- Pool ID:     ${poolId}\n`);
}

setupLoadBalancer().catch((err) => {
  console.error('❌ Setup encountered an unexpected error:', err.message);
  process.exit(1);
});
