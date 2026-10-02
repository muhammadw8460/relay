type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
type Fields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return err;
}

/**
 * One JSON object per line. CloudWatch Logs Insights parses these fields
 * automatically, so `filter correlationId = "..."` follows a request from the
 * API handler, through the queue, into the worker.
 */
export function createLogger(base: Fields = {}): Logger {
  const write = (level: Level, message: string, fields: Fields = {}) => {
    const entry: Fields = { level, message, timestamp: new Date().toISOString(), service: 'relay', ...base };
    for (const [key, value] of Object.entries(fields)) {
      entry[key] = key === 'error' || value instanceof Error ? serializeError(value) : value;
    }
    const line = JSON.stringify(entry);
    if (level === 'ERROR') console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, f) => write('DEBUG', m, f),
    info: (m, f) => write('INFO', m, f),
    warn: (m, f) => write('WARN', m, f),
    error: (m, f) => write('ERROR', m, f),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}
