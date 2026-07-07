import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface StructuredToolResultOptions {
  summary: string;
  fields: Record<string, unknown>;
  sections?: Array<{ label: string; text: string }>;
  isError?: boolean;
  meta?: Record<string, unknown>;
}

export interface PreviewTextResult {
  preview: string;
  truncated: boolean;
  originalChars: number;
  omittedChars: number;
}

export function stripAnsi(text: string): string {
  return text.replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    ''
  );
}

export function formatFieldValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function structuredText(
  summary: string,
  fields: Record<string, unknown>,
  sections: Array<{ label: string; text: string }> = []
): string {
  const lines = [
    `summary: ${summary}`,
    ...Object.entries(fields).map(([key, value]) => `${key}: ${formatFieldValue(value)}`),
  ];

  for (const section of sections) {
    lines.push('', `[${section.label}]`, section.text || '(空)');
  }

  return lines.join('\n');
}

export function structuredResult(options: StructuredToolResultOptions): CallToolResult {
  const sections = options.sections ?? [];
  const text = structuredText(options.summary, options.fields, sections);
  const cardSections = sections.map((section) => {
    const preview = previewText(section.text, 1200);
    return {
      label: section.label,
      preview: preview.preview,
      truncated: preview.truncated,
      originalChars: preview.originalChars,
      omittedChars: preview.omittedChars,
    };
  });
  const result = {
    // 完整的模型可读内容只保留在 content 中，避免 structuredContent/_meta 重复携带大段文本。
    content: [{ type: 'text' as const, text }],
    structuredContent: {
      summary: options.summary,
      ...options.fields,
      sectionCount: sections.length,
      sectionLabels: sections.map((section) => section.label),
    },
    _meta: {
      card: {
        summary: options.summary,
        fields: options.fields,
        sections: cardSections,
      },
      ...(options.meta ?? {}),
    },
    ...(options.isError ? { isError: true } : {}),
  };

  return result as CallToolResult;
}

export function previewText(text: string, maxChars: number): PreviewTextResult {
  if (text.length <= maxChars) {
    return {
      preview: text,
      truncated: false,
      originalChars: text.length,
      omittedChars: 0,
    };
  }

  const headChars = Math.max(1, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(1, Math.floor(maxChars * 0.3));
  const omittedChars = Math.max(0, text.length - headChars - tailChars);

  return {
    preview: `${text.slice(0, headChars)}\n\n...[truncated ${omittedChars} chars]...\n\n${text.slice(-tailChars)}`,
    truncated: true,
    originalChars: text.length,
    omittedChars,
  };
}

export function asciiTreeEntry(kind: 'dir' | 'file', name: string): string {
  return `${kind === 'dir' ? '[D]' : '[F]'} ${name}`;
}
