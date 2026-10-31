// Allowances, request allowlists, server-computed cost and allowance periods.
//
// THE COMMERCIAL NUMBERS LIVE HERE AND IN ONE ENVIRONMENT VARIABLE. Every
// allowance below is a default that ALLOWANCES_JSON can override without a
// deploy, because the figures are provisional containment settings to be
// validated against real usage, not conclusions.
//
// NOTHING IN THIS FILE TRUSTS THE CLIENT ABOUT MONEY. What a call cost is
// computed from the usage the provider returned; what a call may cost before
// it is made is bounded from the request's own size and its output limit.

import { createHash } from 'node:crypto';
import { supabaseRPC } from './_supabase.js';
import { report } from './_lib.js';

// MARK: - Switches

/// Off until launch. While false, every attested caller is metered as `beta`
/// (no Free/Pro allowances, a per-device daily cost cap) so the testers on
/// builds 174 and 175 keep exactly the experience they have, and the shared
/// token is metered as `legacy`. Flip to true in the same release that ships
/// the App Store products.
export function billingEnforced() {
  return (process.env.BILLING_ENFORCED || 'false').toLowerCase() === 'true';
}

/// Free AI can be stopped on its own, before anything a subscriber pays for.
export function freeAIEnabled() {
  return (process.env.FREE_AI_ENABLED || 'true').toLowerCase() !== 'false';
}

/// TestFlight AND App Review purchases are Sandbox transactions, including on
/// the public build, so this stays ON after launch. Sandbox is ISOLATED rather
/// than refused: its own `sbx:` subjects, metered as tier `sandbox` against its
/// own daily budget, never counted as a paid subscriber, never raising the
/// emergency ceiling. Setting false is an emergency switch only: it would fail
/// App Review's purchase test.
export function sandboxAllowed() {
  return (process.env.ALLOW_SANDBOX_TRANSACTIONS || 'true').toLowerCase() !== 'false';
}

export const BUNDLE_ID = process.env.APP_BUNDLE_ID || 'com.shinethankappan.agni';

export const PRODUCTS = {
  monthly: process.env.PRODUCT_ID_MONTHLY || 'com.shinethankappan.agni.pro.monthly',
  annual: process.env.PRODUCT_ID_ANNUAL || 'com.shinethankappan.agni.pro.annual'
};

export function planOf(productId) {
  if (productId === PRODUCTS.monthly) return 'monthly';
  if (productId === PRODUCTS.annual) return 'annual';
  return null;
}

// MARK: - Allowances

/// PROVISIONAL. Containment settings, not proof of margin. See the
/// implementation report before raising any of them.
///
///   photo   photo and nutrition-label analyses (a drink photo counts once)
///   search  AI-assisted search, describe, refine and ingredient breakdowns
///   web     uncached ingredient web lookups (a shared-cache hit is free)
///   costCapUSD  aggregate provider cost per allowance period, ALL routes
///   burst   photo analyses per UTC day
export const DEFAULT_ALLOWANCES = {
  // Lifetime introductory sample. Never resets.
  free:  { photo: 3,   search: 10,  web: 0,  costCapUSD: 0.50, burst: 3,  dayCostCapUSD: null },
  // The whole 7-day trial.
  trial: { photo: 25,  search: 25,  web: 3,  costCapUSD: 1.00, burst: 25, dayCostCapUSD: null },
  // Each monthly allowance period, monthly and annual plans alike.
  // Offer B' (Shine, 2026-10-31): 100/60/5 at $3.00. 100/100/10 cost ~$3.18 for a
  // typical subscriber, over any cap that leaves the annual plan a margin.
  pro:   { photo: 100, search: 60,  web: 5,  costCapUSD: 3.00, burst: 25, dayCostCapUSD: null },
  // Testers before launch: no counts, the same daily cost bound as before.
  beta:  { photo: null, search: null, web: null, costCapUSD: null, burst: null, dayCostCapUSD: 1.00 },
  // The shared token: no identity worth an allowance, so a tight daily bound.
  legacy:{ photo: null, search: null, web: null, costCapUSD: null, burst: null, dayCostCapUSD: 0.50 }
};

export function allowances() {
  let override = {};
  try {
    override = JSON.parse(process.env.ALLOWANCES_JSON || '{}');
  } catch (error) {
    report('ALLOWANCES_JSON', error);
  }
  const merged = {};
  for (const [tier, values] of Object.entries(DEFAULT_ALLOWANCES)) {
    merged[tier] = { ...values, ...(override[tier] || {}) };
  }
  return merged;
}

/// Calls that consume no credit (the drink check in front of every photo)
/// still cost money, so they get a daily count of their own.
export const UNCREDITED_DAY_CAP = Number(process.env.UNCREDITED_DAY_CAP || 60);
/// One tap: a drink check, the estimate, the parallel parts a big plate is
/// split into (up to three beside the main call), and a couple of retries.
export const MAX_CALLS_PER_ACTION = Number(process.env.MAX_CALLS_PER_ACTION || 8);
/// Longer than any function may run (estimate is 120s, for streams), so a
/// reservation is only ever treated as abandoned when nothing can still be
/// settling it.
export const STALE_RESERVATION_SECONDS = 180;
/// Calls one subject may have in flight at once. Every reservation is a bound
/// the real cost should never beat, but a web search's result size is an
/// estimate, not a bound: capping concurrency caps how far a period can ever
/// overshoot its ceiling to this many calls' worth of misestimate.
/// A split plate has four calls in flight at once (main + three parts).
export const MAX_OPEN_RESERVATIONS = Number(process.env.MAX_OPEN_RESERVATIONS || 6);

// MARK: - Features

const ALL = ['free', 'trial', 'pro', 'beta', 'legacy'];
const PAID = ['trial', 'pro', 'beta', 'legacy'];

/// Every paid feature, what it may send, which allowance it draws on, and who
/// may use it. A feature not listed here cannot be paid for.
///
/// `image`: 'required' | 'optional' | 'none'. `maxImageB64` is base64
/// characters: a 1568px JPEG at Agni's quality is about 270k, the 512px drink
/// check about 40k, so both caps are several times the real payload and far
/// below anything abusive.
export const FEATURES = {
  photo:          { bucket: 'photo',  counts: true,  image: 'required', maxImageB64: 1_200_000, tiers: ALL },
  label:          { bucket: 'photo',  counts: true,  image: 'required', maxImageB64: 1_200_000, tiers: ALL },
  drink_check:    { bucket: 'photo',  counts: false, image: 'required', maxImageB64: 200_000,   tiers: ALL },
  // A drink photo counts once, here. A typed drink has no image and draws on
  // search instead (see bucketFor).
  drink_id:       { bucket: 'photo',  counts: true,  image: 'optional', maxImageB64: 1_200_000, tiers: ALL },
  variant_search: { bucket: 'search', counts: true,  image: 'none', tiers: ALL },
  describe:       { bucket: 'search', counts: true,  image: 'none', tiers: ALL },
  refine:         { bucket: 'search', counts: true,  image: 'none', tiers: PAID },
  breakdown:      { bucket: 'search', counts: true,  image: 'none', tiers: PAID },
  // Server-built requests.
  research:       { bucket: 'search', counts: true,  image: 'none', tiers: ALL },
  ingredient:     { bucket: 'web',    counts: true,  image: 'none', tiers: PAID }
};

export function bucketFor(feature, hasImage) {
  if (feature === 'drink_id' && !hasImage) return 'search';
  return FEATURES[feature]?.bucket || null;
}

/// What an OLD build (174, 175) is doing, inferred from its request, because
/// it does not say. Used for telemetry and for metering; it can only ever
/// pick a feature at least as restrictive as the one the call really is.
export function inferFeature(request) {
  const model = String(request?.model || '');
  const content = request?.messages?.[0]?.content;
  const image = Array.isArray(content) ? content.find(block => block?.type === 'image') : null;
  const size = image ? String(image?.source?.data || '').length : 0;
  const sonnet = model.startsWith('claude-sonnet');
  if (image && sonnet) return 'photo';
  if (image) {
    // A small Haiku image is the routing check, unless its pixels say it is a
    // full photo (a plain picture can compress small): then it is an
    // identification, which counts, rather than a refusal.
    const dims = imageDimensions(image?.source?.data);
    const small = size <= FEATURES.drink_check.maxImageB64
      && (!dims || Math.max(dims.width, dims.height) <= MAX_IMAGE_EDGE.drink_check);
    return small ? 'drink_check' : 'drink_id';
  }
  if (sonnet) return 'breakdown';
  return 'variant_search';
}

// MARK: - The request allowlist

export const ALLOWED_MODELS = new Set([
  'claude-sonnet-5',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001'
]);

/// Sized from the app's own prompts, with room: the largest system prompt is
/// about 17k characters of source, the largest schema well under 10k.
export const REQUEST_CAPS = {
  maxTokens: 4096,
  /// A streamed answer may be longer, and only a streamed one: a 13-dish plate
  /// ran out at 4096 because thinking counts against max_tokens. A buffered
  /// answer that long would outrun UPSTREAM_TIMEOUT_MS and fail anyway.
  streamMaxTokens: 8192,
  systemChars: 32_000,
  textChars: 12_000,
  schemaChars: 32_000
};

const TOP_LEVEL_KEYS = new Set(['model', 'max_tokens', 'system', 'output_config', 'messages', 'temperature', 'stream']);
const EFFORTS = new Set(['low', 'medium', 'high']);
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png']);

/// Refuses anything the app does not send.
///
/// The proxy used to forward any body that named an allowed model, kept
/// max_tokens under the cap and had one message. That let a caller add
/// tools (web search at a cent a go), extra images, a 1.5MB system prompt, or
/// a cache_control of their own. Now the shape is the app's shape or nothing.
export function validateModelRequest(feature, request) {
  const spec = FEATURES[feature];
  if (!spec || feature === 'research' || feature === 'ingredient') return `Feature ${feature} is not allowed here.`;
  if (!request || typeof request !== 'object' || Array.isArray(request)) return 'Missing request body.';
  for (const key of Object.keys(request)) {
    if (!TOP_LEVEL_KEYS.has(key)) return `Field ${key} is not allowed.`;
  }
  if (!ALLOWED_MODELS.has(request.model)) return `Model ${request.model} is not allowed.`;
  // Only the meal photo streams and thinks at a set effort; nothing else the
  // app sends does, so nothing else may.
  const streams = feature === 'photo';
  if (request.stream !== undefined && !streams) return 'stream is not allowed here.';
  if (request.stream !== undefined && typeof request.stream !== 'boolean') return 'stream must be true or false.';
  const tokenCap = request.stream === true ? REQUEST_CAPS.streamMaxTokens : REQUEST_CAPS.maxTokens;
  if (!Number.isInteger(request.max_tokens) || request.max_tokens < 1 || request.max_tokens > tokenCap) {
    return `max_tokens must be a whole number from 1 to ${tokenCap}.`;
  }
  if (request.temperature !== undefined
      && !(typeof request.temperature === 'number' && request.temperature >= 0 && request.temperature <= 1)) {
    return 'temperature is out of range.';
  }
  if (typeof request.system !== 'string' || request.system.length > REQUEST_CAPS.systemChars) {
    return 'system must be a string within the size limit.';
  }
  if (request.output_config !== undefined) {
    const config = request.output_config;
    const keys = streams ? ['format', 'effort'] : ['format'];
    if (!config || typeof config !== 'object' || Object.keys(config).some(k => !keys.includes(k))) {
      return streams ? 'output_config may only carry a format and an effort.' : 'output_config may only carry a format.';
    }
    if (config.effort !== undefined && !EFFORTS.has(config.effort)) return 'output_config.effort is not allowed.';
    const format = config.format;
    if (!format || format.type !== 'json_schema' || typeof format.schema !== 'object'
        || Object.keys(format).some(k => k !== 'type' && k !== 'schema')) {
      return 'output_config.format must be a json_schema.';
    }
    if (JSON.stringify(format.schema).length > REQUEST_CAPS.schemaChars) return 'Schema is too large.';
  }
  if (!Array.isArray(request.messages) || request.messages.length !== 1) return 'Expected exactly one message.';
  const message = request.messages[0];
  if (!message || message.role !== 'user' || Object.keys(message).some(k => k !== 'role' && k !== 'content')) {
    return 'The message must be a plain user message.';
  }
  if (!Array.isArray(message.content) || message.content.length < 1 || message.content.length > 2) {
    return 'The message must have one text block and at most one image.';
  }
  let texts = 0;
  let images = 0;
  for (const block of message.content) {
    if (block?.type === 'text') {
      if (Object.keys(block).some(k => k !== 'type' && k !== 'text')) return 'Text blocks may not carry extra fields.';
      if (typeof block.text !== 'string' || block.text.length > REQUEST_CAPS.textChars) return 'Text is too long.';
      texts += 1;
    } else if (block?.type === 'image') {
      if (Object.keys(block).some(k => k !== 'type' && k !== 'source')) return 'Image blocks may not carry extra fields.';
      const source = block.source || {};
      if (source.type !== 'base64' || !MEDIA_TYPES.has(source.media_type)
          || typeof source.data !== 'string'
          || Object.keys(source).some(k => !['type', 'media_type', 'data'].includes(k))) {
        return 'Images must be inline JPEG or PNG.';
      }
      if (source.data.length > (spec.maxImageB64 || 0)) return 'That photo was too large to send.';
      const size = imageDimensions(source.data);
      const edge = MAX_IMAGE_EDGE[feature] || MAX_IMAGE_EDGE.default;
      if (size && Math.max(size.width, size.height) > edge) return 'That photo was larger than Agni sends.';
      images += 1;
    } else {
      return `Content of type ${block?.type} is not allowed.`;
    }
  }
  if (texts !== 1) return 'Expected exactly one text block.';
  if (spec.image === 'none' && images > 0) return `${feature} does not take an image.`;
  if (spec.image === 'required' && images !== 1) return `${feature} needs one image.`;
  return null;
}

export function hasImage(request) {
  const content = request?.messages?.[0]?.content;
  return Array.isArray(content) && content.some(block => block?.type === 'image');
}

/// Prompt caching of the shared system prompt, per feature, OFF until measured.
///
/// It changes nothing the model reads: the same system text, marked as a
/// cacheable prefix. Whether it saves anything depends on the prompt clearing
/// the model's minimum cacheable length and on calls landing inside the cache
/// lifetime, neither of which is assumed. tools/measure-prompt-cache.mjs
/// measures it; usage records cache reads and writes on every call either way.
export function promptCacheFeatures() {
  return new Set(String(process.env.PROMPT_CACHE_FEATURES || '')
    .split(',').map(s => s.trim()).filter(Boolean));
}

export function withPromptCache(request) {
  if (typeof request.system !== 'string') return request;
  return {
    ...request,
    system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }]
  };
}

// MARK: - Cost

/// List prices per million tokens, verified 2026-10-07 on the provider's
/// pricing page. PRICING_JSON overrides without a deploy when they change.
export const DEFAULT_PRICING = {
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 }
};
export const WEB_SEARCH_USD = Number(process.env.WEB_SEARCH_USD || 0.01);
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

export function pricing(model) {
  let override = {};
  try { override = JSON.parse(process.env.PRICING_JSON || '{}'); } catch { override = {}; }
  // An unknown model costs the dearest known rate, never nothing.
  return override[model] || DEFAULT_PRICING[model] || { input: 2.0, output: 10.0 };
}

/// What one call cost, from the provider's own usage report.
///
/// Input tokens, output tokens (thinking is billed as output and is already
/// inside output_tokens), cache reads at 0.1x, cache writes at 1.25x (5 min)
/// or 2x (1 hour), and server-side web searches at their published price.
export function costFromUsage(model, usage) {
  const rate = pricing(model);
  const n = value => Math.max(0, Number(value) || 0);
  const input = n(usage?.input_tokens);
  const output = n(usage?.output_tokens);
  const cacheRead = n(usage?.cache_read_input_tokens);
  const creation = usage?.cache_creation;
  const write5m = creation ? n(creation.ephemeral_5m_input_tokens) : n(usage?.cache_creation_input_tokens);
  const write1h = creation ? n(creation.ephemeral_1h_input_tokens) : 0;
  const searches = n(usage?.server_tool_use?.web_search_requests);
  const perToken = rate.input / 1_000_000;
  return input * perToken
    + output * (rate.output / 1_000_000)
    + cacheRead * perToken * CACHE_READ_MULTIPLIER
    + write5m * perToken * CACHE_WRITE_5M_MULTIPLIER
    + write1h * perToken * CACHE_WRITE_1H_MULTIPLIER
    + searches * WEB_SEARCH_USD;
}

export function usageBreakdown(usage) {
  const n = value => (value === undefined || value === null ? null : Math.max(0, Number(value) || 0));
  const creation = usage?.cache_creation;
  const cacheRead = n(usage?.cache_read_input_tokens) || 0;
  const write5m = creation ? n(creation.ephemeral_5m_input_tokens) : n(usage?.cache_creation_input_tokens);
  const write1h = creation ? n(creation.ephemeral_1h_input_tokens) : 0;
  return {
    input: n(usage?.input_tokens),
    output: n(usage?.output_tokens),
    cacheRead,
    cacheWrite5m: write5m || 0,
    cacheWrite1h: write1h || 0,
    webSearches: n(usage?.server_tool_use?.web_search_requests) || 0,
    cacheStatus: cacheRead > 0 ? 'hit' : ((write5m || 0) + (write1h || 0) > 0 ? 'write' : 'none')
  };
}

/// The most an image can cost in input tokens, whatever its size: Sonnet 5's
/// high-resolution tier tops out at 4,784; Haiku 4.5 downsizes to 1568px.
function imageTokenCeiling(model) {
  return String(model).startsWith('claude-sonnet') ? 4_784 : 3_300;
}

/// The longest edge the app ever sends: 1568 for a meal or label, 512 for the
/// drink routing check. A little headroom, and anything larger is refused, so
/// nobody can make the proxy pay for pixels the app would never send.
export const MAX_IMAGE_EDGE = { drink_check: 640, default: 1600 };

/// Width and height from a JPEG's frame header or a PNG's IHDR, without
/// decoding anything. Null when the bytes are not one of those.
export function imageDimensions(base64) {
  let bytes;
  try { bytes = Buffer.from(String(base64 || '').slice(0, 400_000), 'base64'); } catch { return null; }
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('latin1', 12, 16) === 'IHDR') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = bytes.readUInt16BE(i + 2);
    // Every start-of-frame marker (baseline, progressive, lossless...) except
    // DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

/// Input tokens one image can cost: width x height / 750 at the size it
/// arrives (the provider only ever scales DOWN), never above the model's
/// ceiling. An image whose size cannot be read is charged the ceiling.
export function imageTokenBound(model, base64) {
  const ceiling = imageTokenCeiling(model);
  const size = imageDimensions(base64);
  if (!size || !size.width || !size.height) return ceiling;
  return Math.min(ceiling, Math.ceil((size.width * size.height) / 750) + 85);
}

/// TOKENS ARE BOUNDED BY BYTES. Claude's tokenizer works on UTF-8 bytes and
/// no token is shorter than one, so a text's UTF-8 length is a hard ceiling
/// on its token count. The old figure, 2.5 characters a token, held for the
/// app's English prompts and NOT for a hostile caller: 32k characters of
/// punctuation, CJK or emoji is up to 32k+ tokens, and the system prompt,
/// text and schema are all the caller's to fill.
export function textTokenBound(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/// Framing the provider adds around a message, a structured-output format and
/// each block. Generous; it is a few hundred tokens against tens of thousands.
const FRAMING_TOKENS = 600;

/// A CONSERVATIVE bound on what a call can cost, reserved before it is made.
///
/// Every input byte as a token, images from their real dimensions up to the
/// model's ceiling, output at the full max_tokens, and a cached prompt as if
/// every call were a cache write. No usage the provider can report for an
/// allowlisted request exceeds it (test/billing.test.mjs proves it on hostile
/// inputs). The real figure replaces it the moment the call settles; it costs
/// headroom only while a call is in flight.
export function reservationFor(feature, request, { promptCached = false } = {}) {
  const rate = pricing(request.model);
  const content = request.messages?.[0]?.content || [];
  let inputTokens = FRAMING_TOKENS
    + textTokenBound(typeof request.system === 'string' ? request.system : JSON.stringify(request.system || ''));
  for (const block of content) {
    if (block?.type === 'text') inputTokens += textTokenBound(block.text);
    if (block?.type === 'image') inputTokens += imageTokenBound(request.model, block.source?.data);
  }
  if (request.output_config) inputTokens += textTokenBound(JSON.stringify(request.output_config));
  const inputRate = (rate.input / 1_000_000) * (promptCached ? CACHE_WRITE_5M_MULTIPLIER : 1);
  return round6(inputTokens * inputRate + Number(request.max_tokens || 0) * (rate.output / 1_000_000));
}

/// The server-built routes (research, ingredient), from their own constants.
///
/// WEB SEARCH IS AN ESTIMATE, NOT A BOUND. Results arrive as input, and each
/// further step of the server-side tool loop re-reads everything before it,
/// so k searches of R tokens bill about k*base + R*k(k+1)/2 input tokens. R is
/// not published or capped by the provider; 20k is above what was observed.
/// The per-subject in-flight cap (MAX_OPEN_RESERVATIONS) bounds what a bad
/// guess can cost before settle corrects it.
export function reservationForServerCall({ model, system = '', user = '', systemChars, userChars, maxTokens,
                                           maxSearches = 0, searchResultTokens = 20_000 }) {
  const rate = pricing(model);
  const base = FRAMING_TOKENS
    + (system ? textTokenBound(system) : Number(systemChars || 0) * 4)
    + (user ? textTokenBound(user) : Number(userChars || 0) * 4);
  const steps = maxSearches + 1;
  const inputTokens = base * steps + (maxSearches > 0 ? searchResultTokens * (maxSearches * (maxSearches + 1)) / 2 : 0);
  return round6(inputTokens * (rate.input / 1_000_000) + maxTokens * (rate.output / 1_000_000)
    + maxSearches * WEB_SEARCH_USD);
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// MARK: - Allowance periods

const EPOCH = new Date(0);
const INFINITY = 'infinity';

/// Adds whole calendar months to an ANCHOR, clamping to the month's last day.
///
/// Always measured from the anchor, never chained: a subscription bought on
/// 31 January has periods starting 28 (or 29) February, 31 March, 30 April,
/// 31 May. Chaining would drift it to the 28th for ever after February.
export function addMonths(anchor, months) {
  const a = new Date(anchor);
  const year = a.getUTCFullYear();
  const month = a.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(a.getUTCDate(), lastDay);
  return new Date(Date.UTC(targetYear, targetMonth, day,
    a.getUTCHours(), a.getUTCMinutes(), a.getUTCSeconds(), a.getUTCMilliseconds()));
}

/// The allowance period a subscriber is in right now.
///
/// BOTH PLANS SIT AT ONE SERVICE LEVEL in one subscription group, because they
/// give identical Pro benefits. A switch between them is therefore a
/// CROSSGRADE, and Apple applies a crossgrade between different durations at
/// the next renewal date, as a new transaction. Nothing here assumes an
/// immediate upgrade; the period follows the verified transaction dates.
///
/// Periods are anchored on the EXPIRY of the current transaction, not on its
/// purchase date, because the expiry is what Apple keeps regular: a renewal
/// can be charged up to a day early, and billing recovered inside the grace
/// period keeps the original renewal date.
///
///   Free          the lifetime of the device: one period, never resets.
///   Trial         the trial itself, purchase to expiry.
///   Monthly plan  one month ending at the transaction's expiry.
///   Annual plan   the year ending at expiry, split into monthly sub-periods
///                 from its start (31 Jan -> 28 Feb -> 31 Mar), the last one
///                 ending at expiry.
///   Trial to paid the paid transaction starts where the trial ended, so the
///                 first paid period starts fresh there.
///   Crossgrade    monthly <-> annual takes effect at renewal: a new
///                 transaction whose term starts at the old expiry, so the new
///                 period starts exactly where the old one ended.
///   Grace         Apple's billing grace period extends the current period to
///                 the end of grace.
///
/// SWITCHING NEVER BUYS A FRESH ALLOWANCE. Any paid period that begins less
/// than a month after the previous paid period began (a refund and
/// repurchase, an immediate upgrade if the group is ever changed, Sandbox's
/// five-minute renewals) CARRIES the previous period's usage and cost forward.
/// That rule is in SQL (agni__carry_source), where the row is created.
export function periodFor(tier, subscription, now = new Date()) {
  if (tier === 'free' || tier === 'beta' || tier === 'legacy') {
    return { start: EPOCH, end: INFINITY };
  }
  const purchase = new Date(subscription.purchase_date);
  const expires = new Date(subscription.expires_date);
  const grace = subscription.grace_expires_date ? new Date(subscription.grace_expires_date) : null;
  const end = grace && grace > expires ? grace : expires;

  if (tier === 'trial') return { start: purchase, end };

  const annual = planOf(subscription.product_id) === 'annual';
  // The start of the term this transaction pays for: a month (or a year)
  // before its expiry. A renewal charged early does not move it. A
  // transaction shorter than its plan (Sandbox renews monthly plans every few
  // minutes) starts at its purchase instead.
  const term = addMonths(expires, annual ? -12 : -1);
  const anchor = purchase > term ? purchase : term;
  if (!annual) return { start: anchor, end };

  let n = 0;
  while (addMonths(anchor, n + 1) <= now && n < 24) n += 1;
  const start = addMonths(anchor, n);
  const next = addMonths(anchor, n + 1);
  return { start, end: next < end ? next : end };
}

// MARK: - Tier

/// What a key is entitled to right now, from verified state only.
///
/// A Sandbox subscription is Pro or trial for what it UNLOCKS (App Review and
/// TestFlight must see the real product) but is metered as `sandbox`: see
/// budgetTierFor.
export function tierFor(context, { enforced = billingEnforced(), now = new Date(), allowSandbox = sandboxAllowed() } = {}) {
  if (!enforced) return 'beta';
  if (!context?.subscription_subject) return 'free';
  const s = context;
  if (s.revocation_date) return 'free';
  if (!planOf(s.product_id)) return 'free';
  if (s.environment !== 'Production' && !(allowSandbox && s.environment === 'Sandbox')) return 'free';
  const expires = s.expires_date ? new Date(s.expires_date) : null;
  const grace = s.grace_expires_date ? new Date(s.grace_expires_date) : null;
  const until = grace && expires && grace > expires ? grace : expires;
  if (!until || until <= now) return 'free';
  return s.is_trial ? 'trial' : 'pro';
}

/// The tier a call is ACCOUNTED under: the ledger, the day's budget and the
/// emergency ceiling's degradation order. Sandbox spend is real money, so it
/// counts toward the day's total, but under its own cap, degraded before any
/// paying subscriber, and never as `pro`.
export function budgetTierFor(tier, context) {
  if ((tier === 'pro' || tier === 'trial') && context?.environment === 'Sandbox') return 'sandbox';
  return tier;
}

// MARK: - Identity helpers

export function hashIP(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || String(req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown');
  const salt = process.env.IP_HASH_SALT || 'agni-ip';
  return createHash('sha256').update(salt + '|' + ip).digest('hex').slice(0, 32);
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{8,80}$/;

/// Ids from the client: an install id, an action id, a request id. Anything
/// that does not look like an id is not used as one.
export function cleanId(value) {
  const text = String(value ?? '').trim();
  return ID_PATTERN.test(text) ? text : null;
}

// MARK: - Reserve and settle

/// Reserves, calls, settles. The single path every paid provider call takes.
///
/// `call` makes the provider request and returns
///   { ok, httpStatus, usage, payload, text, providerRequestId, ambiguous }.
/// `ambiguous` means nobody can know whether the provider billed (a timeout or
/// a connection lost mid-flight), so the reservation is kept as the cost.
export async function metered({ subject, subjectKind, tier, budgetTier, authPath, feature, bucket, counts,
                                actionId, requestId, model, period, reserveUSD, limits: given }, call) {
  const limits = given || allowances()[tier] || allowances().legacy;
  const limit = limits[bucket] ?? null;

  const rows = await supabaseRPC('agni_reserve', {
    p_subject: subject,
    p_subject_kind: subjectKind,
    p_request_id: requestId,
    p_action_id: actionId,
    p_feature: feature,
    p_bucket: bucket,
    p_counts: counts,
    p_tier: tier,
    p_auth_path: authPath,
    p_model: model,
    p_period_start: new Date(period.start).toISOString(),
    p_period_end: period.end === INFINITY ? INFINITY : new Date(period.end).toISOString(),
    p_limit: limit,
    p_cost_cap: limits.costCapUSD ?? null,
    p_day_cost_cap: limits.dayCostCapUSD ?? null,
    p_burst: limits.burst ?? null,
    p_uncredited_day_cap: limits.uncreditedDayCap ?? UNCREDITED_DAY_CAP,
    p_reserve_usd: reserveUSD,
    p_max_calls_per_action: MAX_CALLS_PER_ACTION,
    p_stale_seconds: STALE_RESERVATION_SECONDS,
    p_budget_tier: budgetTier || tier,
    p_max_open: limits.maxOpen ?? MAX_OPEN_RESERVATIONS
  });
  const reservation = Array.isArray(rows) ? rows[0] : rows;
  if (!reservation) throw new Error('reserve returned nothing');
  if (reservation.alert) raiseAlert(reservation.alert, { tier, feature });
  if (!reservation.allowed) return { refused: reservation, limits, limit };

  let outcome;
  try {
    // The reservation is handed over so a streamed call can report what is
    // left in its headers, which go out before the call finishes.
    outcome = await call(reservation);
  } catch (error) {
    report(`provider ${feature}`, error);
    outcome = { ok: false, ambiguous: true, error };
  }

  const breakdown = usageBreakdown(outcome.usage);
  const actual = outcome.usage
    ? costFromUsage(model, outcome.usage)
    : (outcome.ambiguous ? reserveUSD : 0);
  const label = outcome.ok ? 'ok'
    : outcome.ambiguous ? 'ambiguous'
    : outcome.httpStatus ? `provider_${outcome.httpStatus}` : (outcome.reason || 'failed');

  await settle(subject, requestId, {
    actual, success: !!outcome.ok, outcome: outcome.label || label, breakdown,
    httpStatus: outcome.httpStatus ?? null, providerRequestId: outcome.providerRequestId ?? null
  });

  return { outcome, reservation, limits, limit, actualUSD: round6(actual) };
}

/// Two attempts. If both fail the reservation stands as the cost and expires
/// in two minutes, which over-counts and never under-counts.
async function settle(subject, requestId, { actual, success, outcome, breakdown, httpStatus, providerRequestId }) {
  const args = {
    p_subject: subject,
    p_request_id: requestId,
    p_actual_usd: round6(actual),
    p_success: success,
    p_outcome: String(outcome).slice(0, 40),
    p_input: breakdown.input,
    p_output: breakdown.output,
    p_cache_read: breakdown.cacheRead,
    p_cache_w5: breakdown.cacheWrite5m,
    p_cache_w1h: breakdown.cacheWrite1h,
    p_web: breakdown.webSearches,
    p_cache_status: breakdown.cacheStatus,
    p_http_status: httpStatus,
    p_provider_request_id: providerRequestId ? String(providerRequestId).slice(0, 80) : null
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await supabaseRPC('agni_settle', args);
      return;
    } catch (error) {
      report(`settle attempt ${attempt + 1}`, error);
    }
  }
}

// MARK: - Refusals the app can act on

function resetsAt(retryAfter) {
  return retryAfter > 0 ? new Date(Date.now() + retryAfter * 1000).toISOString() : null;
}

const BUCKET_WORDS = {
  photo: 'photo and label analyses',
  search: 'AI searches',
  web: 'ingredient web lookups'
};

/// Turns a reservation refusal into a status, a type and words.
///
/// EXHAUSTION AND OUTAGES ARE DIFFERENT ANSWERS. "You have used this month's
/// analyses, they come back on 3 November" and "AI is paused for a while" ask
/// for different things from the person reading them, and both end with what
/// still works.
export function allowanceRefusal(refused, { tier, bucket, limit }) {
  const reason = refused.reason;
  const resets = resetsAt(Number(refused.retry_after || 0));
  const fallback = 'Search, barcode and quick add still work.';
  const base = { tier, bucket, used: refused.used ?? null, limit: limit ?? null, resetsAt: resets };
  switch (reason) {
    case 'allowance': {
      const words = BUCKET_WORDS[bucket] || 'AI actions';
      const message = tier === 'free'
        ? `You have used the free ${words}. Agni Pro includes more. ${fallback}`
        : `You have used this period's ${words}. ${fallback}`;
      return { status: 402, type: 'allowanceExhausted', message, ...base };
    }
    case 'budget':
      return { status: 402, type: 'allowanceExhausted',
               message: `You have reached this period's AI limit. ${fallback}`,
               ...base, bucket: 'cost' };
    case 'burst':
      return { status: 429, type: 'usageLimitReached',
               message: `That is today's limit for AI analysis. ${fallback}`, ...base };
    case 'spend':
      return { status: 429, type: 'usageLimitReached',
               message: "That is today's limit for photo analysis. You can still log meals by hand.", ...base };
    case 'degraded':
      return { status: 503, type: 'aiPaused',
               message: `AI analysis is paused for a little while. ${fallback}`, ...base };
    case 'in_flight':
    case 'duplicate':
      return { status: 409, type: 'duplicateRequest', message: 'That request is already being handled.', ...base };
    case 'action_limit':
    case 'busy':
      return { status: 429, type: 'rateLimited', message: 'Agni is catching up. Try again in a moment.', ...base };
    default:
      return { status: 503, type: 'serviceUnavailable',
               message: `AI analysis is unavailable right now. ${fallback}`, ...base };
  }
}

export function subscriptionRequired(feature) {
  return {
    status: 402, type: 'subscriptionRequired', feature,
    message: 'This is part of Agni Pro. Search, barcode and quick add still work.'
  };
}

export function sendRefusal(res, body) {
  const { status, ...rest } = body;
  const { type, message, ...detail } = rest;
  if (rest.resetsAt && status === 429) {
    const seconds = Math.max(1, Math.round((new Date(rest.resetsAt) - Date.now()) / 1000));
    res.setHeader('retry-after', String(seconds));
  }
  res.status(status).setHeader('content-type', 'application/json');
  res.send(JSON.stringify({ error: { type, message }, allowance: detail }));
}

// MARK: - Alerts

/// Logged with a fixed prefix (a Vercel log drain or a search finds it), and
/// posted to ALERT_WEBHOOK_URL when one is set. Fire and forget: an alert that
/// can fail a request is worse than no alert.
export function raiseAlert(text, detail = {}) {
  console.error(`[agni-alert] ${text} ${JSON.stringify(detail)}`);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `Agni: ${text}`, detail }),
    signal: AbortSignal.timeout(3000)
  }).catch(() => {});
}
