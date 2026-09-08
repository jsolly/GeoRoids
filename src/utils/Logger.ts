import { createLogRecord, stringifyLogRecord } from '../../shared/logRecords';
import { LOGGING } from '../constants';
import { getClientLogContext } from './clientLogContext';
import { LogLevel, shouldEmitLog } from './logLevel';

function describeForwardingFailure(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unknown forwarding error';
  }
}

function levelName(level: LogLevel): 'debug' | 'info' | 'warn' | 'error' {
  return LogLevel[level].toLowerCase() as 'debug' | 'info' | 'warn' | 'error';
}

class Logger {
  private static forwardingFailureReported = false;
  private static instance: Logger;
  private currentLevel: LogLevel;
  private static isForwarderInitialized = false;

  private constructor() {
    this.currentLevel = LogLevel.INFO;
    this.initializeLogLevel();
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private initializeLogLevel(): void {
    if (typeof window === 'undefined') {
      return;
    }
    const configured = LOGGING.GLOBAL_LOG_LEVEL?.toLowerCase();
    this.currentLevel =
      configured === 'debug'
        ? LogLevel.DEBUG
        : configured === 'warn'
          ? LogLevel.WARN
          : configured === 'error'
            ? LogLevel.ERROR
            : LogLevel.INFO;
  }

  setLogLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  getLogLevel(): LogLevel {
    return this.currentLevel;
  }

  debug(category: string, message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, category, message, context);
  }

  info(category: string, message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, category, message, context);
  }

  warn(category: string, message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, category, message, context);
  }

  error(category: string, message: string, error?: Error, context?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, category, message, context, error);
  }

  private log(
    level: LogLevel,
    category: string,
    message: string,
    context?: Record<string, unknown>,
    error?: Error
  ): void {
    if (!shouldEmitLog(level, this.currentLevel)) {
      return;
    }
    const record = createLogRecord({
      timestamp: new Date().toISOString(),
      source: 'client',
      level: levelName(level),
      releaseId: import.meta.env['VITE_COMMIT_HASH'] || 'dev',
      category,
      message,
      context: error ? { ...context, error } : context,
      ...getClientLogContext(),
    });
    const line = stringifyLogRecord(record);

    if (LOGGING.WRITE_TO_CONSOLE) {
      this.writeToConsole(level, line);
    }

    const forwardState = level === LogLevel.INFO && category === 'STATE';
    if (
      LOGGING.FORWARD_TO_SERVER &&
      (level <= LogLevel.WARN || forwardState) &&
      category !== 'LOG_FORWARD'
    ) {
      this.forwardToServer(line);
    }
  }

  private forwardToServer(line: string): void {
    import('./logForwarder')
      .then(({ forwardLogToServer, startClientLogForwarder }) => {
        if (!Logger.isForwarderInitialized) {
          startClientLogForwarder();
          Logger.isForwarderInitialized = true;
        }
        forwardLogToServer(line);
        Logger.forwardingFailureReported = false;
      })
      .catch((error: unknown) => {
        if (Logger.forwardingFailureReported) {
          return;
        }
        Logger.forwardingFailureReported = true;
        try {
          console.warn(
            `[LOG_FORWARD] Client log forwarding unavailable: ${describeForwardingFailure(error)}`
          );
        } catch {
          // Console implementations are outside the logger contract.
        }
      });
  }

  private writeToConsole(level: LogLevel, line: string): void {
    switch (level) {
      case LogLevel.ERROR:
        console.error(line);
        break;
      case LogLevel.WARN:
        console.warn(line);
        break;
      case LogLevel.INFO:
        console.info(line);
        break;
      case LogLevel.DEBUG:
        console.debug(line);
        break;
    }
  }
}

export const logger = Logger.getInstance();
