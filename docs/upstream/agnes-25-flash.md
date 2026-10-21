> ## Documentation Index
> Fetch the complete documentation index at: https://wiki.agnes-ai.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Agnes 2.5 Flash

> Generally available upgrade of Agnes 2.0 Flash with improved coding capability, agent workflows, tool calling, and multimodal understanding.

> [!NOTE]
>
> Agnes 2.5 Flash is a generally available language model upgraded from Agnes 2.0 Flash. It keeps the same OpenAI-compatible Chat Completions integration path while improving the experience for coding, agent workflows, tool calling, multi-turn conversations, reasoning, and image understanding.

> **Model**
>
> `agnes-2.5-flash`

> **API Endpoints**
>
> Chat Completions: `POST /v1/chat/completions`
>
> Responses: `POST /v1/responses`
>
> Messages: `POST /v1/messages`

> **Release Status**
>
> Generally available to users with Agnes API access.

> **Upgrade Path**
>
> API-compatible upgrade from the deprecated `agnes-2.0-flash` model.

## Overview

Agnes 2.5 Flash is designed as the next-step upgrade for developers already using Agnes 2.0 Flash. In most integrations, you only need to replace the `model` value with `agnes-2.5-flash`; the Base URL, endpoint, headers, message format, streaming format, tool-calling format, and image URL input format remain the same.

The model focuses on a smoother developer experience, stronger instruction following, more stable multi-turn output, and improved code-specific capability for generation, debugging, refactoring, explanation, and agentic coding workflows.

> [!TIP]
>
> Use `agnes-2.5-flash` directly as the model name. `agnes-2.0-flash` is deprecated, so existing integrations should migrate as soon as possible.

## Core Capabilities

> **Chat Completions**
>
> Generate high-quality responses for conversations, applications, and business systems.

> **Multi-turn Conversations**
>
> Maintain context consistency across continuous interactions.

> **Image URL Input**
>
> Accept visual content through publicly accessible image URLs.

> **Image Understanding**
>
> Analyze screenshots, describe images, answer visual questions, and extract visual information.

> **Tool Calling**
>
> Support function calling and external tool orchestration.

> **Agent Workflows**
>
> Improved planning, execution, context tracking, and multi-step task completion.

> **Code-specialized Tasks**
>
> Optimized for code generation, debugging, refactoring, explanation, and patch-style development workflows.

> **Streaming**
>
> Return responses in real time for a better interactive experience.

## Use Cases

> **AI Assistants**
>
> General Q\&A, productivity assistants, personal assistants, and in-app copilots.

> **Autonomous Agents**
>
> Multi-step task execution, planning, tool use, and workflow scheduling.

> **Coding Assistants**
>
> Code generation, bug fixing, refactoring suggestions, code review, test generation, and code explanation.

> **Customer Support**
>
> FAQ automation, support chatbots, and service workflow automation.

> **Search and Q\&A**
>
> Retrieval-based answers, summarization, and information extraction.

> **Image Understanding**
>
> Screenshot analysis, image description, visual Q\&A, and structured extraction.

## Upgrade from Agnes 2.0 Flash

If you already call `agnes-2.0-flash`, the 2.5 Flash migration is intentionally small.

| Item | Agnes 2.0 Flash (Deprecated) | Agnes 2.5 Flash |
| - | - | - |
| Endpoint | `POST /v1/chat/completions` | `POST /v1/chat/completions` |
| Base URL | `https://apihub.agnes-ai.com/v1` | `https://apihub.agnes-ai.com/v1` |
| Model name | `agnes-2.0-flash` | `agnes-2.5-flash` |
| Message format | OpenAI-compatible `messages` | Same |
| Streaming | `stream: true` | Same |
| Tool calling | `tools` and `tool_choice` | Same |
| Image URL input | `messages[].content[].image_url` | Same |

> [!TIP]
>
> For existing integrations, migration can usually be handled as a model-name change. Do not continue using the deprecated `agnes-2.0-flash` model as a compatibility fallback.

## API Reference

### Endpoint

```text theme={null}
POST https://apihub.agnes-ai.com/v1/chat/completions
```

### Headers

```bash theme={null}
-H "Authorization: Bearer YOUR_API_KEY"
-H "Content-Type: application/json"
```

### Request Parameters

| Parameter | Type | Required | Description |
| - | - | - | - |
| `model` | string | Yes | Model name. Use `agnes-2.5-flash`. |
| `messages` | array | Yes | Conversation messages, including `system`, `user`, and `assistant` messages. |
| `messages[].content` | string / array | Yes | Message content. It can be plain text or an array of content blocks containing `text` and `image_url`. |
| `temperature` | number | No | Controls randomness. Lower values produce more deterministic results. |
| `top_p` | number | No | Controls nucleus sampling. Lower values make output more focused. |
| `max_tokens` | number | No | Maximum number of tokens to generate in the response. |
| `stream` | boolean | No | Whether to enable streaming output. |
| `tools` | array | No | Tool definitions for tool-calling workflows. |
| `tool_choice` | string / object | No | Controls whether and how the model uses tools. |
| `chat_template_kwargs` | object | No | Extension field for enabling Thinking and other features in OpenAI-compatible requests. |
| `thinking` | object | No | Field for enabling Thinking mode in Anthropic-compatible requests. |

## Image URL Input

Agnes 2.5 Flash supports passing text and image URLs in the same `messages` request.

| Input Type | Format | Description |
| - | - | - |
| Text | `text` | Plain text instruction or question. |
| Image URL | `image_url` | Pass image content through a publicly accessible image URL. |

```json theme={null}
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "Describe the content of this image."
    },
    {
      "type": "image_url",
      "image_url": {
        "url": "https://example.com/image.jpg"
      }
    }
  ]
}
```

## Request Examples

**Basic Chat**

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.5-flash",
    "messages": [
      {
        "role": "system",
        "content": "You are a helpful AI assistant."
      },
      {
        "role": "user",
        "content": "Explain how autonomous agents use tools to complete tasks."
      }
    ],
    "temperature": 0.7,
    "max_tokens": 1024
  }'
```

**Streaming**

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.5-flash",
    "messages": [
      {
        "role": "user",
        "content": "Write a short product introduction for an AI assistant app."
      }
    ],
    "stream": true
  }'
```

**Tool Calling**

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.5-flash",
    "messages": [
      {
        "role": "user",
        "content": "What is the weather like in Singapore today?"
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get the current weather for a location",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {
                "type": "string",
                "description": "The city and country"
              }
            },
            "required": ["location"]
          }
        }
      }
    ]
  }'
```

**Image Understanding**

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.5-flash",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "Describe the content of this image."
          },
          {
            "type": "image_url",
            "image_url": {
              "url": "https://example.com/image.jpg"
            }
          }
        ]
      }
    ]
  }'
```

## Response Format

```json theme={null}
{
  "id": "chatcmpl_xxx",
  "object": "chat.completion",
  "created": 1774432125,
  "model": "agnes-2.5-flash",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Autonomous agents use tools by understanding the user's goal, breaking it into steps, selecting the right tools, executing actions, and using the results to complete the task."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 35,
    "completion_tokens": 58,
    "total_tokens": 93
  }
}
```

### Response Fields

| Field | Type | Description |
| - | - | - |
| `id` | string | Unique ID of the completion request. |
| `object` | string | Object type, usually `chat.completion`. |
| `created` | integer | Request timestamp. |
| `model` | string | Model used for the request. |
| `choices` | array | List of generated responses. |
| `choices[].message.role` | string | Role of the message sender. |
| `choices[].message.content` | string | Content generated by the model. |
| `choices[].finish_reason` | string | Reason generation stopped. |
| `usage` | object | Token usage information. |

## Responses API

In addition to Chat Completions, this model supports the OpenAI Responses API. Use `input` instead of `messages`.

### Responses endpoint

```text theme={null}
POST https://apihub.agnes-ai.com/v1/responses
```

### Responses request parameters

| Parameter | Type | Required | Description |
| - | - | - | - |
| `model` | string | Yes | Model name. Use `agnes-2.5-flash`. |
| `input` | string / array | Yes | A plain text prompt or an array of structured input messages. |
| `max_output_tokens` | integer | No | Maximum output budget. Use a larger value for reasoning models to avoid an `incomplete` response. |

**Text Input**

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.5-flash",
    "input": "Explain how autonomous agents use tools.",
    "max_output_tokens": 1024
  }'
```

**Structured Input**

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.5-flash",
    "input": [
      {
        "role": "user",
        "content": [
          {
            "type": "input_text",
            "text": "Explain how autonomous agents use tools."
          }
        ]
      }
    ],
    "max_output_tokens": 1024
  }'
```

### Responses output format

```json theme={null}
{
  "id": "resp_xxx",
  "object": "response",
  "status": "completed",
  "model": "agnes-2.5-flash",
  "output": [
    {
      "type": "reasoning",
      "summary": []
    },
    {
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "text": "Autonomous agents use tools to retrieve data and perform actions."
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 40,
    "output_tokens": 80,
    "total_tokens": 120
  },
  "error": null,
  "incomplete_details": null
}
```

| Field | Type | Description |
| - | - | - |
| `id` | string | Unique response ID. |
| `object` | string | Object type, usually `response`. |
| `status` | string | Response state, such as `completed` or `incomplete`. |
| `output` | array | Ordered response items, including reasoning and assistant messages. |
| `output[].type` | string | Item type, such as `reasoning` or `message`. |
| `output[].content[].type` | string | Content type. Generated text uses `output_text`. |
| `output[].content[].text` | string | Generated assistant text. |
| `usage` | object | Token usage information. |
| `error` | object / null | Error details when the request fails. |
| `incomplete_details` | object / null | Explains why a response stopped before completion. |

> [!WARNING]
>
> The current response does not include a top-level `output_text` convenience field. Extract generated text from message items where `output[].type` is `message` and `output[].content[].type` is `output_text`.

> [!NOTE]
>
> Reasoning items are optional and can use either `content[].reasoning_text` or `summary[].summary_text`. Token usage field names can also vary by model: support both `input_tokens` / `output_tokens` and `prompt_tokens` / `completion_tokens`.

> [!TIP]
>
> If `status` is `incomplete`, inspect `incomplete_details` and retry with a larger `max_output_tokens` value. Reasoning models can consume part of the output budget before producing assistant text.

## Messages API

This model also supports the Anthropic-compatible Messages API. Send conversation input in `messages` and authenticate with `x-api-key`.

### Messages endpoint

```text theme={null}
POST https://apihub.agnes-ai.com/v1/messages
```

### Messages headers

```bash theme={null}
-H "x-api-key: YOUR_API_KEY"
-H "anthropic-version: 2023-06-01"
-H "Content-Type: application/json"
```

### Messages request parameters

| Parameter | Type | Required | Description |
| - | - | - | - |
| `model` | string | Yes | Model name. Use `agnes-2.5-flash`. |
| `max_tokens` | integer | Yes | Maximum number of output tokens. Use a larger value for reasoning models. |
| `messages` | array | Yes | Conversation messages containing `user` and `assistant` roles. |
| `messages[].role` | string | Yes | Message role. Use `user` or `assistant`. |
| `messages[].content` | string / array | Yes | Plain text or an array of Anthropic-compatible content blocks. |
| `system` | string / array | No | System instruction for the request. |
| `temperature` | number | No | Controls output randomness. |
| `stream` | boolean | No | Whether to return a streaming response. |

### Messages request example

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-2.5-flash",
    "max_tokens": 1024,
    "system": "You are a helpful AI assistant.",
    "messages": [
      {
        "role": "user",
        "content": "Explain how autonomous agents use tools."
      }
    ]
  }'
```

### Messages response format

```json theme={null}
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "model": "agnes-2.5-flash",
  "content": [
    {
      "type": "text",
      "text": "Autonomous agents use tools to retrieve information and perform actions."
    }
  ],
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 290,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "output_tokens": 28
  }
}
```

| Field | Type | Description |
| - | - | - |
| `id` | string | Unique message ID. |
| `type` | string | Object type, usually `message`. |
| `role` | string | Response role, usually `assistant`. |
| `model` | string | Model used for the request. |
| `content` | array | Ordered response content blocks. |
| `content[].type` | string | Content block type. Generated text uses `text`. |
| `content[].text` | string | Generated assistant text. |
| `stop_reason` | string | Reason generation stopped, such as `end_turn` or `max_tokens`. |
| `usage.input_tokens` | integer | Number of input tokens used. |
| `usage.output_tokens` | integer | Number of output tokens generated. |
| `usage.cache_creation_input_tokens` | integer | Input tokens written to the prompt cache. |
| `usage.cache_read_input_tokens` | integer | Input tokens read from the prompt cache. |

> [!NOTE]
>
> Read generated text from content blocks where `content[].type` is `text`. If `stop_reason` is `max_tokens`, retry with a larger `max_tokens` value.

## Thinking Mode

For coding, debugging, reasoning, and agent workflows, you can enable Thinking mode to improve task decomposition and problem-solving quality.

**OpenAI-compatible Format**

```json theme={null}
{
  "model": "agnes-2.5-flash",
  "messages": [
    {
      "role": "user",
      "content": "Help me write a Python script to process a CSV file."
    }
  ],
  "chat_template_kwargs": {
    "enable_thinking": true
  }
}
```

**Anthropic-compatible Format**

```json theme={null}
{
  "model": "agnes-2.5-flash",
  "messages": [
    {
      "role": "user",
      "content": "Help me refactor this TypeScript function and explain the changes."
    }
  ],
  "thinking": {
    "type": "enabled",
    "budget_tokens": 2048
  }
}
```

> [!TIP]
>
> For regular coding tasks, start with `budget_tokens: 2048`. For complex debugging, refactoring, or multi-step agent workflows, increase the budget as needed.

## Best Practices

> **Prompt Structure**
>
> ```text theme={null}
> [Role] + [Task] + [Context] + [Requirements] + [Output Format]
> ```

> **Product Copywriting**
>
> ```text theme={null}
> You are a product marketing expert. Write a concise App Store description for an AI assistant app. The tone should be clear, professional, and user-friendly.
> ```

> **Coding Tasks**
>
> ```text theme={null}
> Help me debug this React component. The issue is that the button state does not update after clicking. Explain the cause and provide the corrected code.
> ```

> **Agent Workflows**
>
> ```text theme={null}
> You are an autonomous research agent. Search for relevant information, summarize the key findings, and return the result in a structured format with source links.
> ```

> **Image Understanding Tasks**
>
> ```text theme={null}
> Analyze this screenshot. Identify the main UI elements, explain the possible issue, and provide suggestions to improve the user experience.
> ```

## Limits and Pricing

Agnes 2.5 Flash is generally available. Availability, rate limits, and billing behavior follow the entitlement shown for your Agnes AI account and API key.

| Item | Value |
| - | - |
| Context window | `512K` |
| Maximum output | `65.5K` |

| Type | Standard Price | Current Price |
| - | - | - |
| Cached input | `$0.005 / 1M tokens` | `$0 / 1M tokens` |
| Input tokens | `$0.05 / 1M tokens` | `$0 / 1M tokens` |
| Output tokens | `$0.15 / 1M tokens` | `$0 / 1M tokens` |

## Integration Checklist

> [!TIP]
>
> Use `agnes-2.5-flash` as the model name.

> [!TIP]
>
> Basic chat completion requests must include `model` and `messages`.

> [!TIP]
>
> Image inputs must use publicly accessible `image_url` values.

> [!TIP]
>
> Set `stream` to `true` when you need streaming responses.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.