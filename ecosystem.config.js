module.exports = {
  apps: [
    {
      name: 'mos-bellecour',
      script: 'server.js',
      interpreter: 'node',
      interpreter_args: '--experimental-sqlite',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      watch: false,
      max_memory_restart: '300M',
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
};
