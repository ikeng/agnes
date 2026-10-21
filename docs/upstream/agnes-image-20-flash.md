> ## Documentation Index
> Fetch the complete documentation index at: https://wiki.agnes-ai.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Agnes Image 2.0 Flash

> A high-performance image generation and editing model for text-to-image, image-to-image, and multi-image composition workflows.

> [!NOTE]
>
> Agnes Image 2.0 Flash is a high-performance Agnes AI image generation and editing model. It supports text-to-image, image-to-image, and multi-image composition workflows for creative design, marketing visuals, e-commerce product images, and social content production.

> **Model**
>
> `agnes-image-2.0-flash`

> **API Endpoint**
>
> `POST /v1/images/generations`

> **Supported Workflows**
>
> Text-to-image, image-to-image, and multi-image composition.

> **Current Price**
>
> All supported output-resolution tiers and input reference images are currently free.

## Overview

Agnes Image 2.0 Flash is optimized for fast, high-quality, and cost-effective image production workflows.

The model has appeared on the Artificial Analysis image editing leaderboard with an **ELO score of 1,184**, ranking in the **Top 20** range and demonstrating strong image editing capability.

## Core Capabilities

> **Text-to-image**
>
> Generate images from text prompts.

> **Image-to-image**
>
> Edit, transform, or enhance existing images.

> **Multi-image Input**
>
> Use multiple reference images to create a new image.

> **Image Editing**
>
> Modify composition, style, objects, backgrounds, and scenes.

> **Style Control**
>
> Control artistic style, lighting, layout, and visual direction.

> **Fast Generation**
>
> Designed for frequent, fast, production-grade creative workflows.

## Use Cases

> **Creative Design**
>
> Posters, concept art, and social media visuals.

> **Marketing Content**
>
> Product ads, campaign creatives, and banners.

> **Image Editing**
>
> Object replacement, background replacement, style transfer, and local edits.

> **Character Composition**
>
> Combine multiple characters or reference images into one scene.

> **E-commerce**
>
> Product image enhancement, product staging, and marketing hero images.

> **Social Content**
>
> Memes, avatars, thumbnails, and lifestyle visual assets.

## API Reference

### Endpoint

```text theme={null}
POST https://apihub.agnes-ai.com/v1/images/generations
```

### Headers

```bash theme={null}
-H "Authorization: Bearer YOUR_API_KEY"
-H "Content-Type: application/json"
```

### Request Parameters

| Parameter | Type | Required | Description |
| - | - | - | - |
| `model` | string | Yes | Model name. Use `agnes-image-2.0-flash`. |
| `prompt` | string | Yes | Text prompt describing the target image or editing instruction. |
| `size` | string | Yes | Output image size, such as `1024x768`, `1024x1024`, or `768x1024`. |
| `image` | string\[] | Required for image-to-image | Input image array. Supports public URLs or Data URI Base64. |
| `return_base64` | boolean | No | Use this when text-to-image output should be returned as Base64. |
| `extra_body.response_format` | string | No | Output format. Common values are `url` and `b64_json`. |

## Important Notes

> [!WARNING]
>
> Do not place `response_format` at the top level of the request body. For URL or Base64 output, place it inside `extra_body`.

> **Text-to-image**
>
> Only `model`, `prompt`, and `size` are required. Do not pass `image`.

> **Image-to-image**
>
> Pass image URLs or Data URI Base64 values through `extra_body.image`.

> **No tags Required**
>
> Image-to-image requests do not require `tags: ["img2img"]`.

> **Safe Examples**
>
> Use `YOUR_API_KEY` in public documentation. Do not expose real API keys.

## Request Examples

**Text-to-image: URL Output**

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.0-flash",
    "prompt": "A clean product photo of a glass cube on a white studio background, soft shadows, high detail",
    "size": "1024x768",
    "extra_body": {
      "response_format": "url"
    }
  }'
```

**Text-to-image: Base64 Output**

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.0-flash",
    "prompt": "A clean product photo of a glass cube on a white studio background, soft shadows, high detail",
    "size": "1024x768",
    "return_base64": true
  }'
```

**Image-to-image: URL Input + URL Output**

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.0-flash",
    "prompt": "Transform this image into a cinematic cyberpunk style while preserving the main subject and composition",
    "size": "1024x768",
    "extra_body": {
      "image": [
        "https://example.com/input-image.png"
      ],
      "response_format": "url"
    }
  }'
```

**Image-to-image: Base64 Output**

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.0-flash",
    "prompt": "Make the object orange while preserving the original composition",
    "size": "1024x768",
    "extra_body": {
      "image": [
        "https://example.com/input.png"
      ],
      "response_format": "b64_json"
    }
  }'
```

**Multi-image Composition**

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.0-flash",
    "prompt": "Combine the two characters into an intense fantasy battle scene, dynamic lighting, detailed background, cinematic composition",
    "size": "1024x768",
    "extra_body": {
      "image": [
        "https://example.com/character-1.png",
        "https://example.com/character-2.png"
      ],
      "response_format": "url"
    }
  }'
```

## Response Format

**URL Output**

```json theme={null}
{
  "created": 1780000000,
  "data": [
    {
      "url": "https://storage.googleapis.com/agnes-aigc/xxx.png",
      "b64_json": null,
      "revised_prompt": null
    }
  ]
}
```

**Base64 Output**

```json theme={null}
{
  "created": 1780000000,
  "data": [
    {
      "url": null,
      "b64_json": "iVBORw0KGgoAAAANSUhEUgAA...",
      "revised_prompt": null
    }
  ]
}
```

### Response Fields

| Field | Type | Description |
| - | - | - |
| `created` | integer | Request creation timestamp. |
| `data` | array | List of generated image results. |
| `data[].url` | string / null | Generated image URL. Usually `null` when using Base64 output. |
| `data[].b64_json` | string / null | Base64 image data. Usually `null` when using URL output. |
| `data[].revised_prompt` | string / null | Revised prompt if available. Otherwise `null`. |

## Best Practices

> **Text-to-image Prompts**
>
> Provide clear visual instructions, including subject, scene, style, lighting, composition, and quality requirements.
>
> ```text theme={null}
> [Subject] + [Scene / Background] + [Style] + [Lighting] + [Composition] + [Quality Requirements]
> ```
>
> ```text theme={null}
> A professional product photo of a wireless headphone on a clean white background, soft studio lighting, sharp details, commercial photography style
> ```

> **Image Editing Prompts**
>
> Clearly describe what should change and what should remain unchanged.
>
> ```text theme={null}
> [Editing Instruction] + [Elements to Preserve] + [Target Style / Scene] + [Lighting] + [Composition] + [Quality Requirements]
> ```
>
> ```text theme={null}
> Change the background to a futuristic city at night while keeping the person's face, outfit, and pose unchanged
> ```

> **Multi-image Composition Prompts**
>
> Describe the relationship between the input images and how they should be combined.
>
> ```text theme={null}
> Place the person from the first image beside the robot from the second image in a cinematic sci-fi battle scene
> ```

## FAQ

> **Does Agnes Image 2.0 Flash support text-to-image?**
>
> Yes. Text-to-image requests only require `model`, `prompt`, and `size`. The `image` parameter is not needed.

> **Does Agnes Image 2.0 Flash support image-to-image?**
>
> Yes. Image-to-image requests require input images in `extra_body.image`.

> **Do image-to-image requests require tags?**
>
> No. Do not pass `tags: ["img2img"]`. Use `model`, `prompt`, `size`, and `extra_body.image` instead.

> **Why does top-level response\_format cause an error?**
>
> In this API structure, `response_format` should be placed inside `extra_body`. Placing it at the top level may cause a `400` error.

> **What if the input image URL cannot be accessed?**
>
> Use a publicly accessible HTTPS image URL. If the image cannot be made public, use Data URI Base64 input.

> **How should client timeouts be configured?**
>
> Image generation may take several seconds to tens of seconds. A client timeout of `60s - 360s` is recommended.

## Pricing

`agnes-image-2.0-flash` and `agnes-image-2.1-flash` use the same prices.

| Billing item | List price | Current price |
| - | -: | -: |
| 1K output image | `$10 / 1,000 images` (`$0.010 / image`) | **`$0`** |
| 2K output image | `$18 / 1,000 images` (`$0.018 / image`) | **`$0`** |
| 3K output image | `$21 / 1,000 images` (`$0.021 / image`) | **`$0`** |
| 4K output image | `$24 / 1,000 images` (`$0.024 / image`) | **`$0`** |
| Input reference images from the 4th onward | `$0.003 / image` | **`$0 / image`** |

At list price, the first 3 input reference images do not incur an additional charge. Currently, all output-resolution tiers and input reference images are free. See [Model Pricing](/en/docs/pricing#image-models) for the complete billing rule.

## Integration Checklist

> [!TIP]
>
> Use `agnes-image-2.0-flash` as the model name.

> [!TIP]
>
> Use `https://apihub.agnes-ai.com/v1/images/generations` as the API endpoint.

> [!TIP]
>
> For text-to-image, include `model`, `prompt`, and `size`.

> [!TIP]
>
> For image-to-image, provide input images through `extra_body.image`.

> [!TIP]
>
> Do not place `response_format` at the top level of the request body.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.