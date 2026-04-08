import { z } from 'zod';

export const Qwen35TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const Qwen35ImageBlockSchema = z.object({
  type: z.literal('image'),
  image_url: z.string().optional(),
  placeholder: z.boolean().optional(),
  placeholder_token: z.string().optional(),
  source_kind: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const Qwen35VideoBlockSchema = z.object({
  type: z.literal('video'),
  video_url: z.string().optional(),
  placeholder: z.boolean().optional(),
  placeholder_token: z.string().optional(),
  source_kind: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const Qwen35ContentSchema = z.union([
  z.string(),
  z.array(z.union([Qwen35TextBlockSchema, Qwen35ImageBlockSchema, Qwen35VideoBlockSchema])),
]);

export const Qwen35ToolCallSchema = z.object({
  type: z.literal('function').default('function'),
  id: z.string().optional(),
  function: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).default({}),
  }),
});

export const Qwen35ToolSpecSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const Qwen35MessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: Qwen35ContentSchema }),
  z.object({ role: z.literal('user'), content: Qwen35ContentSchema }),
  z.object({
    role: z.literal('assistant'),
    content: Qwen35ContentSchema,
    reasoning_content: z.string().optional(),
    tool_calls: z.array(Qwen35ToolCallSchema).optional(),
  }),
  z.object({
    role: z.literal('tool'),
    content: Qwen35ContentSchema,
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
  }),
]);

export const Qwen35MetaSchema = z.object({
  endpoint: z.string(),
  status: z.number().int().min(100).max(599),
  ts: z.string(),
  key: z.string().optional(),
  source: z.string().optional(),
  requested_model: z.string().nullable().optional(),
  actual_model: z.string().nullable().optional(),
  stream: z.boolean().optional(),
  thinking_level: z.string().nullable().optional(),
  reasoning_summary_mode: z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
  thinking_type: z.string().nullable().optional(),
  thinking_budget_tokens: z.number().int().nonnegative().nullable().optional(),
  max_output_tokens: z.number().int().nonnegative().nullable().optional(),
  tool_spec_count: z.number().int().nonnegative().optional(),
  tool_choice: z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional(),
  request_contains_non_text_content: z.boolean().default(false),
  request_image_block_count: z.number().int().nonnegative().default(0),
  request_video_block_count: z.number().int().nonnegative().default(0),
  request_tool_call_block_count: z.number().int().nonnegative().default(0),
  request_tool_result_block_count: z.number().int().nonnegative().default(0),
  request_thinking_block_count: z.number().int().nonnegative().default(0),
  response_contains_non_text_content: z.boolean().default(false),
  response_image_block_count: z.number().int().nonnegative().default(0),
  response_video_block_count: z.number().int().nonnegative().default(0),
  response_tool_call_block_count: z.number().int().nonnegative().default(0),
  response_tool_result_block_count: z.number().int().nonnegative().default(0),
  response_thinking_block_count: z.number().int().nonnegative().default(0),
  request_truncated: z.boolean().default(false),
  response_truncated: z.boolean().default(false),
  lossy_source: z.boolean().default(false),
  lossy_reasons: z.array(z.string()).default([]),
  dataset_label: z.string().optional(),
  dataset_source_system: z.string().optional(),
  dataset_source_bucket: z.string().optional(),
  dataset_source_file: z.string().optional(),
  dataset_has_reasoning: z.boolean().optional(),
  dataset_reasoning_chars: z.number().int().nonnegative().optional(),
});

export const Qwen35RecordSchema = z.object({
  id: z.string(),
  request_id: z.string().optional(),
  messages: z.array(Qwen35MessageSchema).min(1),
  tools: z.array(Qwen35ToolSpecSchema).default([]),
  meta: Qwen35MetaSchema,
  label: z.string().optional(),
  source_system: z.string().optional(),
  source_bucket: z.string().optional(),
  source_file: z.string().optional(),
  agentic_label: z
    .object({
      label: z.string(),
      tool_call_count: z.number().int().nonnegative().optional(),
      tool_message_count: z.number().int().nonnegative().optional(),
      dialogue_rounds_est: z.number().int().nonnegative().optional(),
      reasoning_chars: z.number().int().nonnegative().optional(),
      has_reasoning: z.boolean().optional(),
      lossy_source: z.boolean().optional(),
      lossy_reasons: z.array(z.string()).optional(),
    })
    .optional(),
}).superRefine((record, ctx) => {
  const seenUser = record.messages.some((message) => message.role === 'user');
  if (!seenUser) {
    ctx.addIssue({ code: 'custom', message: 'at least one user message is required' });
  }

  let seenNonSystem = false;
  for (const message of record.messages) {
    if (message.role !== 'system') {
      seenNonSystem = true;
    } else if (seenNonSystem) {
      ctx.addIssue({ code: 'custom', message: 'system messages must appear only at the beginning' });
      break;
    }

    if (message.role === 'assistant' && typeof message.reasoning_content === 'string') {
      if (/^\s*<think>/i.test(message.reasoning_content) || /<\/think>\s*$/i.test(message.reasoning_content)) {
        ctx.addIssue({ code: 'custom', message: 'reasoning_content must not include <think> wrappers' });
      }
    }
  }

  if (record.meta.lossy_source && record.meta.lossy_reasons.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'lossy_source requires lossy_reasons' });
  }
});

export type Qwen35Record = z.infer<typeof Qwen35RecordSchema>;
