import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export const readOnlyLocalTool: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

export const writeLocalTool: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

export const destructiveLocalTool: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

export const openWorldDestructiveTool: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};
