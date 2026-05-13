function createLogger(scope) {
  function write(level, message, meta = {}) {
    const line = {
      timestamp: new Date().toISOString(),
      level,
      scope,
      message,
      ...meta
    };

    const serialized = JSON.stringify(line);

    if (level === 'error') {
      console.error(serialized);
      return;
    }

    console.log(serialized);
  }

  return {
    info(message, meta) {
      write('info', message, meta);
    },
    warn(message, meta) {
      write('warn', message, meta);
    },
    error(message, meta) {
      write('error', message, meta);
    }
  };
}

module.exports = {
  createLogger
};
