> ## Documentation Index
> Fetch the complete documentation index at: https://wiki.agnes-ai.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Token Plan FAQ

Agnes AI access plans, API keys, RPM limits, and subscription quotas

**Effective date:** 2026-06-22\
**Video RPM update date:** 2026-06-28\
**Version:** Current public reference version

This document explains the current RPM limits for Agnes AI **text models, image models, and video models**, as well as **Token Plan subscription quotas**.

***

## 1. Access Types

Agnes AI currently supports three access types:

| Access Type | Description |
| :- | :- |
| Free / Default User | Users who have not subscribed to a Token Plan and have not completed enterprise verification |
| Enterprise Verified User | Users who have completed enterprise verification and receive higher baseline access limits |
| Token Plan User | Users who have subscribed to a Token Plan and receive higher RPM limits and subscription quotas |

A single user may have multiple access types at the same time.

For example, a user may have:

* Free / default API keys
* Enterprise verified API keys
* Token Plan API keys

Each API key type uses a separate limit pool.

***

## 2. Token Plan Quotas

In addition to RPM limits, Token Plan users are also subject to subscription quotas.

**RPM limits** and **subscription quotas** apply at the same time.

| Plan | `agnes-3.0-flash` | `agnes-image-2.5-flash` | `agnes-video-2.5-flash` |
| :- | :- | :- | :- |
| Starter | 1,500 requests per 5 hours; 15,000 requests per week | 4,000 images per day | 500 seconds per day |
| Plus | 7,500 requests per 5 hours; 75,000 requests per week | 4,000 images per day | 500 seconds per day |
| Pro | 30,000 requests per 5 hours; 300,000 requests per week | 4,000 images per day | 500 seconds per day |

### Notes

* Text model quotas are counted by **request count**.
* Image model quotas are counted by **generated image count**.
* Video model quotas are counted by **generated video duration in seconds**.
* Token Plan users are subject to both **RPM limits** and **subscription quotas**.

***

## 3. Text Model RPM Limits

> [!WARNING]
>
> **Agnes text model RPM limit adjustment notice**
>
> Dear users,
>
> Due to changes in platform operating policy, effective text model RPM (requests per minute) limits for free and enterprise users have been reduced by **50%**.
>
> | User type | Effective RPM |
> | - | -: |
> | Free users (`default`) | 10 |
> | Enterprise users (`enterprise`) | 20 |
>
> Please adjust your API request frequency to the new limits to avoid rate limiting.
>
> Thank you for your support and understanding!
>
> **The Agnes Team**

**Text RPM update date:** September 23, 2026

| Model Type | User Type | Resolution / Spec | Allowed RPM | Effective RPM |
| :- | :- | :- | :- | :- |
| Text Model | `default` | - | 30 | 10 |
| Text Model | `enterprise` | - | 60 | 20 |
| Text Model | `TokenPlan` | - | 1000 | 1000 |

### Notes

* Free / default users are suitable for basic testing and low-frequency usage.
* Enterprise verified users receive higher baseline text model access.
* Token Plan users are suitable for production usage, high-frequency requests, and agent workflows.

***

## 4. Image Model RPM Limits

Image model RPM limits are based on resolution. In general, higher resolutions have lower RPM limits.

| Model Type | User Type | Resolution / Spec | Allowed RPM | Effective RPM |
| :- | :- | :- | :- | :- |
| Image Model | `default` | 1K | 20 | 10 |
| Image Model | `default` | 2K | 10 | 5 |
| Image Model | `default` | 3K | 2 | 1 |
| Image Model | `default` | 4K | 1 | 1 |
| Image Model | `enterprise` | 1K | 60 | 40 |
| Image Model | `enterprise` | 2K | 40 | 20 |
| Image Model | `enterprise` | 3K | 2 | 1 |
| Image Model | `enterprise` | 4K | 2 | 1 |
| Image Model | `TokenPlan` | 1K | 120 | 100 |
| Image Model | `TokenPlan` | 2K | 120 | 80 |
| Image Model | `TokenPlan` | 3K | 2 | 1 |
| Image Model | `TokenPlan` | 4K | 2 | 1 |

### Notes

* Image model RPM limits vary by resolution.
* Higher resolutions consume more computing resources, so RPM limits are usually lower.
* Token Plan users receive higher image generation limits for **1K / 2K** resolutions.
* Current **3K / 4K** limits are stricter across all user types.
* For image generation, `1K`, `2K`, `3K`, and `4K` are output tiers used with a supported `ratio`. They are not the same as common display labels such as 1080p, 1440p, or UHD.

### Image Size Tiers

For predictable output sizes, request image generation with a tier-based `size` and a supported `ratio`.

For example:

```json theme={null}
{
  "size": "2K",
  "ratio": "16:9"
}
```

The example above uses the **2K** RPM tier and returns `2624x1472`.

If you request unsupported exact dimensions such as `1920x1080` or `2560x1440`, the service may normalize the request to the nearest supported tier and aspect ratio. For example, a 16:9 request can be normalized to the 1K output size `1312x736`.

| Ratio | 1K | 2K | 3K | 4K |
| :- | :- | :- | :- | :- |
| `1:1` | `1024x1024` | `2048x2048` | `3072x3072` | `4096x4096` |
| `3:4` | `864x1152` | `1728x2304` | `2592x3456` | `3456x4608` |
| `4:3` | `1152x864` | `2304x1728` | `3456x2592` | `4608x3456` |
| `16:9` | `1312x736` | `2624x1472` | `3936x2208` | `5248x2944` |
| `9:16` | `736x1312` | `1472x2624` | `2208x3936` | `2944x5248` |
| `2:3` | `832x1248` | `1664x2496` | `2496x3744` | `3328x4992` |
| `3:2` | `1248x832` | `2496x1664` | `3744x2496` | `4992x3328` |
| `21:9` | `1568x672` | `3136x1344` | `4704x2016` | `6272x2688` |

For production workflows that need exact display canvases such as `1920x1080` or `2560x1440`, use `size: "2K"` with `ratio: "16:9"` and then crop or resize the generated image downstream.

***

## 5. Video Model RPM Limits

Video models are subject to both **RPM limits** and **daily video duration quotas**.

| Model Type | User Type | Resolution / Spec | Allowed RPM | Effective RPM |
| :- | :- | :- | :- | :- |
| Video Model | `default` | - | 2 | 1 |
| Video Model | `enterprise` | - | 2 | 2 |
| Video Model | `TokenPlan` | - | 6 | 5 |

### Notes

* Video generation has higher resource costs, so RPM limits are lower than text and low-resolution image models.
* Token Plan users currently receive a video subscription quota of **500 seconds per day**.
* Video models are subject to both **RPM limits** and **daily duration quotas**.

***

## 6. RPM Limits vs. Subscription Quotas

### RPM Limits

RPM means **Requests Per Minute**. It controls how many requests can be processed within one minute.

Examples:

* Free / default users have **1 RPM** for video models.
* Enterprise verified users have **2 RPM** for video models.
* Token Plan users have **5 RPM** for video models.

### Subscription Quotas

Subscription quotas control the total available usage within a specific time window.

Examples:

* Starter users can use **1,500** `agnes-3.0-flash` requests per 5 hours.
* Token Plan users can generate **4,000 images per day**.
* Token Plan users can generate **500 seconds of video per day**.

### Both Limits Apply

Users must comply with both:

1. RPM limits
2. Subscription quota limits

For example, a Token Plan Pro user may have **1000 RPM** for text models, but is still limited by the quota of **30,000 requests per 5 hours** and **300,000 requests per week**.

***

## 7. API Key Types

| API Key Type | Applicable Users | Limit Behavior |
| :- | :- | :- |
| Free / Default Key | All users | Uses the free / default RPM pool |
| Enterprise Verified Key | Enterprise verified users | Uses the enterprise verified RPM pool |
| Token Plan Key | Token Plan users | Uses the Token Plan RPM and subscription quota pool |

Different API key types can be used independently.

***

## 8. Limit Pools

Limits are shared by **API key type**, not by each individual API key.

Creating multiple keys of the same type does not increase the total RPM or total quota.

### Examples

| Scenario | Limit Behavior |
| :- | :- |
| Creating 2 free keys | Both keys share the same free / default RPM pool |
| Creating 2 enterprise verified keys | Both keys share the same enterprise verified RPM pool |
| Creating 1 Token Plan keys | Both keys share the same Token Plan RPM and subscription quota pool |

***

## 9. Recommended Use Cases

| User Type | Recommended Use Cases |
| :- | :- |
| Free / Default User | Basic testing, light personal use, low-frequency integration |
| Enterprise Verified User | Business users, team testing, higher baseline access |
| Token Plan User | Production use, high-frequency API calls, agent workflows, multi-user applications, frequent image or video generation |

***

## 10. FAQ

### Q1: Can creating multiple API keys increase RPM or quota?

No.

Multiple keys of the same type share the same limit pool.

Creating more keys does not increase the total available RPM or quota.

***

### Q2: Can Token Plan users still use free keys?

Yes.

Token Plan users can still use free / default keys.

Free keys and Token Plan keys use separate limit pools.

***

### Q3: Can Token Plan users also become enterprise verified users?

Yes.

After enterprise verification, users can use:

* Free / default keys
* Enterprise verified keys
* Token Plan keys

Each API key type follows its own limit pool.

***

### Q4: Do enterprise verified users automatically receive Token Plan quotas?

No.

Enterprise verification only provides higher baseline RPM limits.

Token Plan quotas are only available after subscribing to a Token Plan.

***

### Q5: Is the image quota counted by request or by generated image?

The image quota is currently counted by **generated image count**.

Token Plan users can currently generate:

* `agnes-image-2.5-flash`
* **4,000 images per day**

***

### Q6: Is the video quota counted by request or by video duration?

The video quota is currently counted by **generated video duration**.

Token Plan users can currently generate:

* `agnes-video-2.5-flash`
* **500 seconds of video per day**

Video RPM limits also apply.

***

### Q7: Do different API key types share limits?

No.

Limits are only shared among API keys of the **same type**.

For example:

* Free keys use the free / default RPM pool.
* Enterprise verified keys use the enterprise verified RPM pool.
* Token Plan keys use the Token Plan RPM and subscription quota pool.

Different API key types do not share limits.

***

## 11. Summary

Agnes AI currently supports three main access types:

* Free / default users
* Enterprise verified users
* Token Plan users

They have different RPM limits for **text models, image models, and video models**.

Token Plan users also receive additional subscription quotas, including:

* Text request quotas
* Image generation quotas
* Video duration quotas

Multiple keys of the same type share the same limit pool.

Different API key types use separate limit pools.

All values in this document are current public reference values and may be adjusted in the future.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.