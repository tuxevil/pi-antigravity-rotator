export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

type WritableLogLevel = Exclude<LogLevel, "silent">;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
	silent: 50,
};

export interface LoggerOptions {
	level?: LogLevel;
	writer?: (line: string, level: WritableLogLevel) => void;
	now?: () => Date;
}

export function parseLogLevel(value: string | undefined): LogLevel {
	if (value === "debug" || value === "info" || value === "warn" || value === "error" || value === "silent") {
		return value;
	}
	return "info";
}

export function shouldLog(messageLevel: WritableLogLevel, configuredLevel: LogLevel): boolean {
	return LEVEL_PRIORITY[messageLevel] >= LEVEL_PRIORITY[configuredLevel];
}

export function redactSensitive(input: unknown): string {
	return String(input)
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/(authorization["'\s:=]+)(Bearer\s+)?[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
		.replace(/("?(?:refresh_token|refreshToken|access_token|accessToken|client_secret|clientSecret)"?\s*[:=]\s*")[^"]+(")/gi, "$1[REDACTED]$2")
		.replace(/("?(?:refresh_token|refreshToken|access_token|accessToken|client_secret|clientSecret)"?\s*[:=]\s*)[^\s,&}]+/gi, "$1[REDACTED]")
		.replace(/1\/\/[A-Za-z0-9._~+/=-]+/g, "1//[REDACTED]");
}

export class Logger {
	private readonly level: LogLevel;
	private readonly writer: (line: string, level: WritableLogLevel) => void;
	private readonly now: () => Date;

	constructor(options: LoggerOptions = {}) {
		this.level = options.level ?? parseLogLevel(process.env.PI_ROTATOR_LOG_LEVEL);
		this.writer = options.writer ?? ((line) => console.log(line));
		this.now = options.now ?? (() => new Date());
	}

	child(scope: string): ScopedLogger {
		return new ScopedLogger(this, scope);
	}

	log(level: WritableLogLevel, scope: string, message: unknown): void {
		if (!shouldLog(level, this.level)) return;
		const ts = this.now().toISOString().slice(11, 19);
		this.writer(`[${ts}] [${scope}] ${redactSensitive(message)}`, level);
	}
}

export class ScopedLogger {
	constructor(private readonly logger: Logger, private readonly scope: string) {}

	debug(message: unknown): void {
		this.logger.log("debug", this.scope, message);
	}

	info(message: unknown): void {
		this.logger.log("info", this.scope, message);
	}

	warn(message: unknown): void {
		this.logger.log("warn", this.scope, message);
	}

	error(message: unknown): void {
		this.logger.log("error", this.scope, message);
	}

	log(level: WritableLogLevel, message: unknown): void {
		this.logger.log(level, this.scope, message);
	}
}

export const logger = new Logger();
