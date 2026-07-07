type ToolHandler = (...args: unknown[]) => unknown | Promise<unknown>;

type TimedRecord = Record<PropertyKey, unknown>;

const WRAPPED_MARKER = Symbol.for("chatgpt-local-repo-bridge-mcp.toolTimingWrapped");

export function installToolTiming(server: unknown): void {
  const target = server as {
    registerTool?: (...args: unknown[]) => unknown;
    tool?: (...args: unknown[]) => unknown;
  };

  if (typeof target.registerTool === "function" && !isWrapped(target.registerTool)) {
    const originalRegisterTool = target.registerTool.bind(target);
    const wrappedRegisterTool = ((...args: unknown[]) => {
      const toolName = typeof args[0] === "string" ? args[0] : "unknown_tool";
      const handlerIndex = findLastFunctionIndex(args);

      if (handlerIndex >= 0) {
        args[handlerIndex] = wrapToolHandler(toolName, args[handlerIndex] as ToolHandler);
      }

      return originalRegisterTool(...args);
    }) as typeof target.registerTool;

    markWrapped(wrappedRegisterTool);
    target.registerTool = wrappedRegisterTool;
  }

  if (typeof target.tool === "function" && !isWrapped(target.tool)) {
    const originalTool = target.tool.bind(target);
    const wrappedTool = ((...args: unknown[]) => {
      const toolName = typeof args[0] === "string" ? args[0] : "unknown_tool";
      const handlerIndex = findLastFunctionIndex(args);

      if (handlerIndex >= 0) {
        args[handlerIndex] = wrapToolHandler(toolName, args[handlerIndex] as ToolHandler);
      }

      return originalTool(...args);
    }) as typeof target.tool;

    markWrapped(wrappedTool);
    target.tool = wrappedTool;
  }
}

function wrapToolHandler(toolName: string, handler: ToolHandler): ToolHandler {
  return async (...args: unknown[]) => {
    const startedAt = Date.now();

    try {
      const result = await handler(...args);
      return attachToolTiming(result, Date.now() - startedAt);
    } catch (error) {
      attachErrorTiming(error, toolName, Date.now() - startedAt);
      throw error;
    }
  };
}

function attachToolTiming(result: unknown, elapsedMs: number): unknown {
  if (!isPlainObject(result)) {
    return result;
  }

  const record = result as TimedRecord;

  if (isPlainObject(record.structuredContent)) {
    record.structuredContent = withTiming(record.structuredContent as TimedRecord, elapsedMs);
    return record;
  }

  return withTiming(record, elapsedMs);
}

function withTiming(record: TimedRecord, elapsedMs: number): TimedRecord {
  const existingTimings = isPlainObject(record.timings) ? (record.timings as TimedRecord) : {};

  return {
    ...record,
    elapsedMs,
    timings: {
      ...existingTimings,
      mcpMethodMs: elapsedMs,
    },
  };
}

function attachErrorTiming(error: unknown, toolName: string, elapsedMs: number): void {
  if (!isPlainObject(error)) {
    return;
  }

  const errorRecord = error as TimedRecord;

  if (errorRecord.toolName === undefined) {
    errorRecord.toolName = toolName;
  }

  if (errorRecord.elapsedMs === undefined) {
    errorRecord.elapsedMs = elapsedMs;
  }
}

function findLastFunctionIndex(args: unknown[]): number {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (typeof args[index] === "function") {
      return index;
    }
  }

  return -1;
}

function isPlainObject(value: unknown): value is TimedRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWrapped(fn: unknown): boolean {
  return Boolean(isObjectLike(fn) && fn[WRAPPED_MARKER]);
}

function markWrapped(fn: unknown): void {
  if (isObjectLike(fn)) {
    fn[WRAPPED_MARKER] = true;
  }
}

function isObjectLike(value: unknown): value is TimedRecord {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}
