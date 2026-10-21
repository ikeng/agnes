> ## Documentation Index
> Fetch the complete documentation index at: https://wiki.agnes-ai.com/llms.txt
> Use this file to discover all available pages before exploring further.

# FAQs

> Frequently Asked Questions (FAQ)

## API Access, Pricing, and Subscriptions

> **1. How do I get an API key?**
>
> 1. Visit the [Agnes AI international platform](https://platform.agnes-ai.com) and sign up or log in.
> 2. Open the **API Key** section in the developer console.
> 3. Create a key, then copy and store it immediately. The complete key is normally shown only once.
> 4. Send the key in the authorization header for every API request:
>
> ```text theme={null}
> Authorization: Bearer YOUR_API_KEY
> ```
>
> Never expose an API key in client-side code, public repositories, screenshots, or logs. If a key is lost or exposed, delete it immediately and create a new one.

> **2. How do I integrate a model?**
>
> Use the following Base URL for the international service:
>
> ```text theme={null}
> https://apihub.agnes-ai.com/v1
> ```
>
> Integration steps:
>
> 1. Copy the exact model ID from the relevant model page.
> 2. Select the endpoint for the model type: `/chat/completions`, `/responses`, or `/messages` for text; `/images/generations` for images; and `/videos` for video.
> 3. Add `Authorization: Bearer YOUR_API_KEY` and `Content-Type: application/json` to the request headers.
> 4. Send the request using the parameters documented for that model.
>
> Minimal text-model request:
>
> ```bash theme={null}
> curl https://apihub.agnes-ai.com/v1/chat/completions \
>   -H "Authorization: Bearer YOUR_API_KEY" \
>   -H "Content-Type: application/json" \
>   -d '{
>     "model": "agnes-2.5-flash",
>     "messages": [{"role": "user", "content": "Hello"}]
>   }'
> ```
>
> See [Quickstart](/en/docs/quickstart) for the complete first-request flow. For third-party clients, open the **Integration Docs** tab.

> **3. How are models priced?**
>
> Agnes AI prices depend on the model and billing item:
>
> * Text models are generally billed by input tokens, cached-input tokens, and output tokens.
> * Image models are billed by output resolution and any input reference images above the free allowance.
> * Video models are billed by output resolution, output duration, input-video duration, and excess reference images.
>
> See the [international model pricing page](/en/docs/pricing) for list prices, current promotional prices, and billing formulas. Token Plan subscription quotas are separate from usage-based model pricing.

> **4. What is Token Plan, and which plans are available?**
>
> Token Plan is a subscription option for higher-frequency and production workloads. Subscribers receive higher RPM limits plus quotas for text requests, generated images, and generated video seconds. RPM limits and subscription quotas apply at the same time.
>
> Three plans are currently available:
>
> * **Starter**: for individual development, prototypes, and light usage.
> * **Plus**: for continuous development, team testing, and medium-volume production usage.
> * **Pro**: for high-volume production, agent workflows, and multi-user applications.
>
> See [Token Plan FAQ](/en/docs/tokenplan) for the current model coverage, RPM limits, and quota windows for each plan.

> **5. How do I subscribe to Token Plan?**
>
> 1. Log in to the [Agnes AI international platform](https://platform.agnes-ai.com).
> 2. Open the [Token Plan subscription page](https://platform.agnes-ai.com/subscribe/subscription?from=website).
> 3. Select Starter, Plus, or Pro based on your expected usage, then complete the subscription flow.
> 4. After activation, follow the console instructions to create or select a Token Plan API key.
> 5. Use that Token Plan key for API requests and monitor RPM, remaining quota, and usage in the console.
>
> Free keys and Token Plan keys use separate limit pools. Creating multiple keys of the same type does not stack RPM or subscription quota.

> **6. How do I troubleshoot API errors?**
>
> First save the HTTP status code, full response body, request time, and request ID when available. Do not share the complete API key. Then verify the Base URL, endpoint, model ID, authorization header, JSON syntax, and parameter types.
>
> | Status | Common cause | Recommended action |
> | - | - | - |
> | `400` | Missing parameters, incorrect field location or type, or an unsupported parameter | Compare the request with the model documentation. For video requests, make sure `seconds` is a string. |
> | `401` | Invalid, deleted, or incorrectly formatted API key | Copy the key again and verify `Authorization: Bearer YOUR_API_KEY`, including the space after `Bearer`. |
> | `402` | Insufficient balance, credits, subscription access, or a failed pre-request usage check | Check the account balance, Token Plan status, and API key type. |
> | `404` | Incorrect endpoint, model, or task identifier | Verify the request path, model ID, and the `video_id` used for video retrieval. |
> | `429` | RPM or subscription quota exceeded | Reduce concurrency and request frequency, wait for the limit window to reset, and check remaining quota. |
> | `5xx` | Temporary service load, upstream failure, or network issue | Retry with exponential backoff such as `1s → 2s → 4s → 8s`. Contact support if the issue persists. |
>
> If text requests work but image or video requests fail, verify that you are using the model-specific endpoint and parameters. Poll video tasks with `video_id` as documented for the selected model. If the issue remains, send the redacted request, response, time, and request ID to [support@agnes-ai.com](mailto:support@agnes-ai.com).

## Other Frequently Asked Questions

> **1. What is this platform?**
>
> This platform provides free AI API services for developers, allowing you to integrate text, image, video, and multimodal AI capabilities into your applications.

> **2. Is the API free to use?**
>
> Yes. Our core AI models are free to use indefinitely. You can continue using the free models without a time limit.

> **3. What are the limitations for free users?**
>
> Free users are subject to RPM limits, which means the number of requests per minute may be limited. If you reach the limit, please wait for a short period before making another request.

> **4. Are multimodal models free?**
>
> Yes. Full multimodal models are available for free, including text, image, video, and multimodal capabilities.

> **5. How do I get started?**
>
> After signing up, you can generate an API key in the dashboard and start making requests using the examples in the documentation.

> **6. How can I check my usage?**
>
> You can view your request usage, limits, and related details in the dashboard under "Usage" or "Billing".

> **7. Why is the API response slow?**
>
> Slow responses may be caused by high server load, large prompts, network latency, or RPM limits. You can try again later, reduce the request size, or switch to another available model.

> **8. What should I do if my API key is lost?**
>
> You can regenerate a new API key in the dashboard. For security reasons, you should delete the old key immediately.

> **9. Where can I find the documentation?**
>
> You can view the integration guides and API examples in our documentation. The documentation provides step-by-step instructions for creating an API key and calling the models.

> **10. How can I get support?**
>
> For general questions, text-based inquiries, or integration support, please contact us by email or join our community.
>
> Email: [support@agnes-ai.com](mailto:support@agnes-ai.com)


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.