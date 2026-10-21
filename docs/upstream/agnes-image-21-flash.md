> ## Documentation Index
> Fetch the complete documentation index at: https://wiki.agnes-ai.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Agnes Image 2.1 Flash

> An upgraded image generation model optimized for high-information-density visuals, with support for text-to-image, image-to-image, and multi-image composition workflows.

> [!NOTE]
>
> Agnes Image 2.1 Flash is an upgraded Agnes AI image generation model. It supports text-to-image, image-to-image, and multi-image composition workflows. Compared with version 2.0, it is better suited for high-information-density images, complex compositions, and detail-rich visual scenes.

> **Model**
>
> `agnes-image-2.1-flash`

> **API Endpoint**
>
> `POST /v1/images/generations`

> **Core Optimization**
>
> High-information-density images, complex visual details, and semantic alignment.

> **Current Price**
>
> All supported output-resolution tiers and input reference images are currently free.

## Overview

Agnes Image 2.1 Flash can generate images from text prompts and transform, redraw, or stylize input images. Results can be returned as image URLs or Base64 data.

> **High-density Visuals**
>
> Better suited for complex scenes, rich compositions, and multi-layer visual elements.

> **Composition Preservation**
>
> Preserves the original composition and subject layout as much as possible during image-to-image editing.

## Core Capabilities

> **Text-to-image**
>
> Generate high-quality images from natural language prompts.

> **Image-to-image**
>
> Transform or improve existing images based on prompt instructions.

> **Multi-image Composition**
>
> Use multiple reference images to create a new combined image.

> **High-information-density Images**
>
> Optimized for detail-rich images with complex layouts and dense visual elements.

> **Composition Preservation**
>
> Preserve the original composition and subject layout when editing input images.

> **Flexible Size Control**
>
> Use resolution tiers such as `1K`, `2K`, `3K`, or `4K` with a supported aspect ratio.

> **URL / Base64 Output**
>
> Return generated images as URLs or Base64 data.

## Use Cases

> **Creative Design**
>
> Concept art, visual exploration, and poster drafts.

> **Marketing Content**
>
> Campaign images, product visuals, and social media creatives.

> **High-density Visual Generation**
>
> Detailed scenes, complex environments, and rich compositions.

> **Image Transformation**
>
> Style transfer, scene relighting, and background transformation.

> **Product Visualization**
>
> Product photos, mockups, and commercial visuals.

> **Social Media Assets**
>
> Covers, banners, thumbnails, and post images.

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
| `model` | string | Yes | Model name. Use `agnes-image-2.1-flash`. |
| `prompt` | string | Yes | Text instruction for image generation or image editing. |
| `size` | string | Yes | Output size tier. Recommended values are `1K`, `2K`, `3K`, and `4K`. Legacy exact-size values such as `1024x768` are also accepted, but unsupported sizes may be normalized. |
| `ratio` | string | No | Aspect ratio used with tier-based `size`. Supported values include `1:1`, `3:4`, `4:3`, `16:9`, `9:16`, `2:3`, `3:2`, and `21:9`. Default is `1:1`. |
| `image` | string\[] | Required for image-to-image or multi-image composition | Input image array. Supports public image URLs or Data URI Base64. Pass multiple images for multi-image composition. |
| `return_base64` | boolean | No | Use this when text-to-image output should be returned as Base64. |
| `extra_body` | object | No | Additional parameters for advanced workflows. |
| `extra_body.response_format` | string | No | Output format. Common values are `url` and `b64_json`. |

## Size and Ratio

For predictable output dimensions, use `size` together with `ratio`.

* Recommended `size` values: `1K`, `2K`, `3K`, `4K`
* Supported `ratio` values: `1:1`, `3:4`, `4:3`, `16:9`, `9:16`, `2:3`, `3:2`, `21:9`
* If you request an unsupported exact size such as `1920x1080` or `2560x1440`, the service may map it to the nearest supported tier and aspect ratio.
* For common 16:9 display assets such as `1920x1080` or `2560x1440`, request `size: "2K"` with `ratio: "16:9"` and then crop or resize downstream if you need an exact final canvas.

> [!WARNING]
>
> `1920x1080` and `2560x1440` are standard display resolutions, but they are not the native output dimensions for this image model. When exact sizes are not supported, the response size may be normalized, for example to the 16:9 `1K` output size `1312x736`.

### Output Dimension Reference

| Ratio | 1K | 2K | 3K | 4K |
| - | - | - | - | - |
| `1:1` | `1024x1024` | `2048x2048` | `3072x3072` | `4096x4096` |
| `3:4` | `864x1152` | `1728x2304` | `2592x3456` | `3456x4608` |
| `4:3` | `1152x864` | `2304x1728` | `3456x2592` | `4608x3456` |
| `16:9` | `1312x736` | `2624x1472` | `3936x2208` | `5248x2944` |
| `9:16` | `736x1312` | `1472x2624` | `2208x3936` | `2944x5248` |
| `2:3` | `832x1248` | `1664x2496` | `2496x3744` | `3328x4992` |
| `3:2` | `1248x832` | `2496x1664` | `3744x2496` | `4992x3328` |
| `21:9` | `1568x672` | `3136x1344` | `4704x2016` | `6272x2688` |

### Example: 16:9 2K Output

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.1-flash",
    "prompt": "A cinematic product hero image for a desktop monitor wallpaper, clean lighting, high detail",
    "size": "2K",
    "ratio": "16:9",
    "extra_body": {
      "response_format": "url"
    }
  }'
```

This returns the 16:9 `2K` tier output size, `2624x1472`.

## Important Notes

> [!WARNING]
>
> Do not place `response_format` at the top level of the request body. For URL output, use `extra_body.response_format: "url"`. For image-to-image Base64 output, use `extra_body.response_format: "b64_json"`.

> **Text-to-image**
>
> Required parameters are `model`, `prompt`, and `size`.

> **Size + Ratio**
>
> Use tier-based `size` values such as `2K` with `ratio`, for example `16:9`.

> **Image-to-image**
>
> Provide input image URLs or Data URI Base64 values in `extra_body.image`.

> **Multi-image Composition**
>
> Pass multiple reference images in `extra_body.image`.

> **Base64 Output**
>
> For text-to-image, use top-level `return_base64: true`.

> **No tags Required**
>
> Image-to-image requests do not require `tags: ["img2img"]`.

## Request Examples

**Text-to-image: URL Output**

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.1-flash",
    "prompt": "A luminous floating city above a misty canyon at sunrise, cinematic realism",
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
    "model": "agnes-image-2.1-flash",
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
    "model": "agnes-image-2.1-flash",
    "prompt": "Transform the scene into a rain-soaked cyberpunk night with neon reflections while preserving the original composition",
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
    "model": "agnes-image-2.1-flash",
    "prompt": "Make the object orange while preserving the original composition",
    "size": "1024x768",
    "extra_body": {
      "image": [
        "https://example.com/input-image.png"
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
    "model": "agnes-image-2.1-flash",
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

**Data URI Base64 Input**

```bash theme={null}
curl https://apihub.agnes-ai.com/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.1-flash",
    "prompt": "Make the object matte black while preserving the original composition",
    "size": "1024x768",
    "extra_body": {
      "image": [
        "data:image/png;base64,BASE64_HERE"
      ],
      "response_format": "b64_json"
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

Generated image URL path:

```text theme={null}
data[0].url
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

Generated Base64 image path:

```text theme={null}
data[0].b64_json
```

### Response Fields

| Field | Type | Description |
| - | - | - |
| `created` | integer | Request creation timestamp. |
| `data` | array | List of generated image results. |
| `data[].url` | string / null | Generated image URL. Usually `null` when using Base64 output. |
| `data[].b64_json` | string / null | Base64 image data. Usually `null` when using URL output. |
| `data[].revised_prompt` | string / null | Revised prompt if available. Otherwise `null`. |

## Prompting Guide

> [!TIP]
>
> For better image generation results, use a clear prompt structure that describes the subject, environment, style, lighting, composition, and quality requirements.

> **Text-to-image Prompt Structure**
>
> ```text theme={null}
> [Subject] + [Scene / Environment] + [Style] + [Lighting] + [Composition] + [Quality Requirements]
> ```
>
> ```text theme={null}
> A luminous floating city above a misty canyon at sunrise, cinematic realism, wide-angle composition, rich architectural details, soft golden light, high visual density
> ```

> **Image-to-image Prompt Structure**
>
> Clearly describe what should change and what should remain unchanged.
>
> ```text theme={null}
> [Change Request] + [New Style / Scene] + [Elements to Add or Remove] + [Elements to Preserve]
> ```
>
> ```text theme={null}
> Turn the daytime street scene into a cinematic cyberpunk night scene, add neon signs and wet road reflections, while preserving the original street layout, camera angle, and main building shapes.
> ```

> **Multi-image Composition Prompt Structure**
>
> Describe the role of each reference image and how they should be combined in the final result.
>
> ```text theme={null}
> [Reference roles] + [Target scene] + [Relationship between images] + [Style / Lighting / Composition]
> ```
>
> ```text theme={null}
> Use the first image as the main character and the second image as the product reference. Create a cinematic campaign poster that preserves the character identity and product shape, with natural lighting and a clean commercial composition.
> ```

> **High-information-density Images**
>
> Agnes Image 2.1 Flash is optimized for complex and detail-rich visuals. For best results, describe the visual hierarchy clearly.
>
> Recommended elements:
>
> * Main subject
> * Background environment
> * Important secondary details
> * Style and lighting
> * Composition constraints
> * Elements to preserve for image-to-image tasks
>
> ```text theme={null}
> A large fantasy harbor city built on cliffs, hundreds of small boats, layered stone bridges, glowing windows, distant mountains, cloudy sunset sky, cinematic fantasy realism, wide-angle composition, rich architectural details, high visual density
> ```

## Common Errors and Troubleshooting

> **Top-level response\_format causes errors**
>
> Do not place `response_format` at the top level.
>
> Incorrect:
>
> ```json theme={null}
> {
>   "model": "agnes-image-2.1-flash",
>   "prompt": "A futuristic city",
>   "size": "1024x768",
>   "response_format": "url"
> }
> ```
>
> Correct:
>
> ```json theme={null}
> {
>   "model": "agnes-image-2.1-flash",
>   "prompt": "A futuristic city",
>   "size": "1024x768",
>   "extra_body": {
>     "response_format": "url"
>   }
> }
> ```

> **Image-to-image does not require tags**
>
> Do not pass `tags: ["img2img"]`. Image-to-image only requires an input image array.
>
> ```json theme={null}
> {
>   "model": "agnes-image-2.1-flash",
>   "prompt": "Make the object blue while preserving the original composition",
>   "size": "1024x768",
>   "extra_body": {
>     "image": ["https://example.com/input.png"],
>     "response_format": "url"
>   }
> }
> ```

> **Input image URL cannot be accessed**
>
> Use public HTTPS image URLs that do not require login, cookies, or private request headers. If the image cannot be made public, use Data URI Base64 input.

> **Request timeout**
>
> Image generation may take several seconds to tens of seconds depending on prompt complexity, image size, and server load. A client timeout of `60s - 360s` is recommended.

> **Missing image parameter for image-to-image**
>
> Image-to-image and multi-image composition require an input image array in `extra_body.image`.

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
> Use `agnes-image-2.1-flash` as the model name.

> [!TIP]
>
> Use `https://apihub.agnes-ai.com/v1/images/generations` as the API endpoint.

> [!TIP]
>
> For text-to-image, include `model`, `prompt`, and `size`.

> [!TIP]
>
> For predictable dimensions, use `size` tiers such as `1K` or `2K` together with `ratio`.

> [!TIP]
>
> For image-to-image and multi-image composition, provide input images through `extra_body.image`.

> [!TIP]
>
> Do not expose temporary or real API keys in public documentation.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.