/**
 * Configuration for exchanges
 * Store API credentials and endpoints
 */

const config = {
    hyperliquid: {
        //apiURL: 'https://api.hyperliquid.xyz',
        apiURL: '/api',
        //wsURL: 'wss://api.hyperliquid.xyz/ws'
        wsURL: 'ws://magic.my:5002/api/ws'
    },
    ostium: {
        //apiURL: 'https://history.ostium.io',
        apiURL: '/api',
        // Use local proxy to bypass CORS for SSE
        //sseURL: 'http://localhost:3001/sse',
        sseURL: '/sse',
        
        // API credentials
        //apiKey: 'PulseTrader01FX2EtClaGlu1FsXry0ZM42HzbXKv20sCn2JJ',
        apiKey: '111',
        //apiSecret: 'mmprejrGVklxRjLZM4idXDoZk8J39vul8i6AnX9O5zMtY72U',
        apiSecret: '222'
    }
};

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
    module.exports = config;
}

