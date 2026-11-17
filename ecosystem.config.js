// pm2 process file:  pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [{
    name: 'curefoods-ess',
    script: 'src/server.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '400M',
    env: { NODE_ENV: 'production' },
    out_file: '/var/log/curefoods-ess/out.log',
    error_file: '/var/log/curefoods-ess/error.log',
    time: true,
  }],
};
