// Dedicated worker process: RUN_WORKER=true node --env-file=.env src/worker.js (set RUN_WORKER=false on API instances)
import './services/notify.js'; console.log('Email worker running');
