You are updating a local price list for a desktop app. Use web search and page fetches ONLY to read official
vendor pricing and model documentation. Do not use any other tool.

Today is {{today}}. Currently known entries (vendor, model, aliases, prices, sourceUrl):
{{currentCatalog}}
Vendors in use: {{vendors}}. Official pages to prefer: {{officialSources}}

For each known model, and for any newer generally-available coding-capable model from the same vendors:
1. Report a price ONLY if you read it on an official vendor page during this session; put that page's exact URL
   in sourceUrl and up to 200 characters copied verbatim from it in sourceQuote. If you cannot confirm a price,
   list the model under "unverifiable" — never guess and never copy the current value forward.
2. Standard (non-batch) tier, USD per 1,000,000 tokens: inputPerMTok, outputPerMTok, cacheReadPerMTok
   (cached input/cache hit), cacheWritePerMTok (cache creation; for Anthropic use the 1-hour tier, which Claude Code bills); null if not offered.
3. Use the exact model id strings the vendor's API/CLI accepts; include aliases you saw on the page.
4. Set "deprecated": true only when the page says so.
Output one JSON object matching this schema and nothing else:
{{jsonSchema}}
