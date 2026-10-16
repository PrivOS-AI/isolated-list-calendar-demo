module.exports = {
  apps: [
    {
      name: 'calendar-events-demo',
      script: 'dist-server/server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: 3011,
        PRIVOS_STANDALONE_IDENTITY_FILE: '/home/roxane/.privos-apps/calendar-events-demo/identity.json',
      },
    },
  ],
};
