// PM2 configuration for the HTTP MCP server.
// (.cjs because package.json uses "type": "module" and PM2 reads this file with require.)
//
// Start it with:  npm run pm2:start     (this builds first, then starts PM2)
module.exports = {
  apps: [
    {
      name: "mcp-file-server",
      script: "dist/server-http.js", // created by: npm run build
      cwd: __dirname,

      // Keep it running: restart after a crash, waiting 2 seconds between tries.
      autorestart: true,
      restart_delay: 2000,
      min_uptime: "5s", // a run shorter than this counts as a failed start...
      max_restarts: 10, // ...and PM2 gives up after this many failed starts in a row
      watch: false,

      // Let PM2 stop the server cleanly (also needed on Windows, which has no signals).
      shutdown_with_message: true,
      kill_timeout: 5000,

      // Port the server listens on (change here if 3000 is taken).
      env: {
        PORT: 3000,
      },
    },
  ],
};