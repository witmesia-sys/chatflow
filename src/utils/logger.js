const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL ?? 'info'];

function log(level, ...args) {
  if (LOG_LEVELS[level] <= CURRENT_LEVEL) {
    const ts = new Date().toISOString();
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
      `[${ts}] [${level.toUpperCase()}]`, ...args
    );
  }
}

export const logger = {
  error: (...args) => log('error', ...args),
  warn:  (...args) => log('warn',  ...args),
  info:  (...args) => log('info',  ...args),
  debug: (...args) => log('debug', ...args),
};
