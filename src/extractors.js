/**
 * Threads Ultimate Scraper - Extractors & Parsers
 * High-speed parsing for Threads Profiles, Posts, Replies, Embedded Search JSON,
 * Media, URL normalization, and Block Detection.
 */

export function sanitizeRecord(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'number') {
        return Number.isNaN(value) || !Number.isFinite(value) ? undefined : value;
    }
    if (Array.isArray(value)) {
        const cleaned = [];
        for (const item of value) {
            const next = sanitizeRecord(item);
            if (next !== undefined) cleaned.push(next);
        }
        return cleaned;
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const next = sanitizeRecord(v);
            if (next !== undefined) out[k] = next;
        }
        return out;
    }
    return value;
}

export function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#(\d+);/g, (_, dec) => {
            const code = parseInt(dec, 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            const code = parseInt(hex, 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        })
        .replace(/&amp;/gi, '&');
}

export function parseSafeInt(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    const num = Number(value);
    return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

// Parse counts like "1.2M", "450K", "3,500"
export function parseCount(str) {
    if (str === null || str === undefined || str === '') return 0;
    if (typeof str === 'number') return Number.isFinite(str) ? Math.round(str) : 0;
    const text = String(str).trim().toUpperCase().replace(/,/g, '');

    let multiplier = 1;
    if (text.includes('B')) multiplier = 1_000_000_000;
    else if (text.includes('M')) multiplier = 1_000_000;
    else if (text.includes('K')) multiplier = 1_000;

    const cleaned = text.replace(/[^0-9.]/g, '');
    const num = parseFloat(cleaned);
    return Number.isNaN(num) ? 0 : Math.round(num * multiplier);
}

// Normalize targetUrls item (@handle, handle, threads.net, threads.com, { url })
export function normalizeThreadsUrl(rawInput) {
    let candidate = '';
    if (typeof rawInput === 'string') {
        candidate = rawInput.trim();
    } else if (rawInput && typeof rawInput === 'object' && typeof rawInput.url === 'string') {
        candidate = rawInput.url.trim();
    }
    if (!candidate) return null;

    if (/^@[a-zA-Z0-9_.-]+$/.test(candidate)) {
        return `https://www.threads.com/${candidate}`;
    }
    if (/^\/?@[a-zA-Z0-9_.-]+/.test(candidate)) {
        const path = candidate.startsWith('/') ? candidate : `/${candidate}`;
        return `https://www.threads.com${path}`;
    }
    if (!/^https?:\/\//i.test(candidate)) {
        if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(candidate)) {
            candidate = `https://${candidate}`;
        } else {
            return null;
        }
    }

    try {
        const parsed = new URL(candidate);
        const host = parsed.hostname.toLowerCase();
        if (
            host === 'threads.net' ||
            host.endsWith('.threads.net') ||
            host === 'threads.com' ||
            host.endsWith('.threads.com')
        ) {
            parsed.protocol = 'https:';
            parsed.hostname = 'www.threads.com';
            return parsed.toString();
        }
        return null;
    } catch (_) {
        return null;
    }
}

export function detectThreadsUrlType(url, explicitMode = 'AUTO_DETECT') {
    if (explicitMode && explicitMode !== 'AUTO_DETECT') return explicitMode;
    const lower = String(url || '').toLowerCase();
    if (lower.includes('/post/')) return 'POSTS';
    if (lower.includes('/search') || /[?&]q=/.test(lower)) return 'SEARCH';
    return 'PROFILES';
}

export function extractSearchKeywordFromUrl(url) {
    try {
        const parsed = new URL(url);
        return (parsed.searchParams.get('q') || '').trim();
    } catch (_) {
        return '';
    }
}

// Detect rate limits, login walls, anti-bot challenges, or unavailable pages
export function detectThreadsBlock({ statusCode = 200, body = '', finalUrl = '' } = {}) {
    const urlLower = String(finalUrl || '').toLowerCase();
    const bodyText = typeof body === 'string' ? body : String(body || '');
    const snippet = bodyText.slice(0, 8192).toLowerCase();

    if (statusCode === 429) {
        return { blocked: true, statusCode: 429, retryable: true, challenge: false, reason: 'HTTP 429 Rate limit from Threads' };
    }
    if (statusCode === 401 || statusCode === 403) {
        return { blocked: true, statusCode, retryable: false, challenge: false, reason: `HTTP ${statusCode} Forbidden by Threads/Meta` };
    }
    if (statusCode >= 400) {
        return { blocked: true, statusCode, retryable: statusCode >= 500, challenge: false, reason: `HTTP ${statusCode} from Threads` };
    }
    if (urlLower.includes('/accounts/login') || urlLower.includes('threads.com/login')) {
        return { blocked: true, statusCode, retryable: false, challenge: false, reason: 'Redirected to Threads/Meta login wall' };
    }
    if (
        snippet.includes('g-recaptcha') ||
        snippet.includes('hcaptcha') ||
        snippet.includes('cf-turnstile') ||
        snippet.includes('checkpoint/challenge') ||
        snippet.includes('help us confirm it')
    ) {
        return { blocked: true, statusCode, retryable: false, challenge: true, reason: 'Meta verification/challenge page encountered' };
    }
    if (bodyText.length < 500 && !bodyText.includes('og:title')) {
        return { blocked: true, statusCode, retryable: true, challenge: false, reason: 'Empty or incomplete HTML returned by Threads' };
    }

    return { blocked: false, statusCode };
}

// Helper to extract email addresses
export function extractEmails(text) {
    if (!text || typeof text !== 'string') return [];
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const matches = text.match(emailRegex) || [];
    const ignored = ['threads.net', 'threads.com', 'instagram.com', 'fb.com', 'meta.com', 'example.com'];
    const unique = [...new Set(matches.map(m => m.trim().toLowerCase()))];
    return unique.filter(e => !ignored.some(d => e === d || e.endsWith(`@${d}`)));
}

// Helper to extract phone numbers
export function extractPhones(text) {
    if (!text || typeof text !== 'string') return [];
    const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,5}/g;
    const matches = text.match(phoneRegex) || [];
    const valid = matches
        .map(p => p.trim())
        .filter(p => {
            const digits = p.replace(/\D/g, '');
            return digits.length >= 8 && digits.length <= 15;
        });
    return [...new Set(valid)];
}

// Extract JSON blocks embedded in <script type="application/json"> tags
export function extractEmbeddedJson(html) {
    if (!html || typeof html !== 'string') return [];
    const results = [];

    const scriptRegex = /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(html)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            results.push(parsed);
        } catch (_) {}
    }

    return results;
}

function readMetaTag(html, propertyName) {
    const regex = new RegExp(`<meta\\b[^>]+property=["']${propertyName}["'][^>]+content=["']([^"']*)["']|<meta\\b[^>]+content=["']([^"']*)["'][^>]+property=["']${propertyName}["']`, 'i');
    const match = html.match(regex);
    const val = match ? (match[1] ?? match[2] ?? '') : '';
    return val ? decodeHtmlEntities(val) : undefined;
}

function formatTakenAt(takenAt) {
    const num = Number(takenAt);
    if (!Number.isFinite(num) || num <= 0) return undefined;
    const ms = num > 1e12 ? num : num * 1000;
    return new Date(ms).toISOString();
}

function extractPostText(postObj, fallbackDesc = '') {
    if (!postObj || typeof postObj !== 'object') return decodeHtmlEntities(fallbackDesc || '');

    if (typeof postObj.caption === 'string' && postObj.caption.trim()) {
        return postObj.caption.trim();
    }
    if (postObj.caption && typeof postObj.caption.text === 'string' && postObj.caption.text.trim()) {
        return postObj.caption.text.trim();
    }
    const fragments = postObj.text_post_app_info?.text_fragments?.fragments;
    if (Array.isArray(fragments) && fragments.length > 0) {
        const joined = fragments.map(f => f?.plaintext || '').join('').trim();
        if (joined) return joined;
    }

    return decodeHtmlEntities(fallbackDesc || '');
}

// Convert a raw Threads embedded JSON post object into a normalized, schema-compliant POST record
export function parsePostObject(postObj, fallbackUrl = '', ogMeta = {}) {
    if (!postObj || typeof postObj !== 'object') {
        if (!ogMeta.description && !ogMeta.image && !ogMeta.video) return null;
    }

    const urlCodeMatch = String(fallbackUrl || '').match(/\/post\/([a-zA-Z0-9_-]+)/i);
    const postCode = postObj?.code ? String(postObj.code) : (urlCodeMatch ? urlCodeMatch[1] : undefined);
    const author = postObj?.user?.username
        ? String(postObj.user.username)
        : (String(fallbackUrl || '').match(/@([a-zA-Z0-9_.-]+)/)?.[1] || undefined);

    const text = extractPostText(postObj, ogMeta.description || '');
    const id = postObj?.id ? String(postObj.id) : (postObj?.pk ? String(postObj.pk) : postCode);
    if (!id && !text) return null;

    const likesCount = parseSafeInt(postObj?.like_count, 0);
    const replyCount = parseSafeInt(postObj?.text_post_app_info?.direct_reply_count, 0);
    const repostCount = parseSafeInt(postObj?.text_post_app_info?.repost_count, 0);
    const quoteCount = parseSafeInt(postObj?.text_post_app_info?.quote_count, 0);
    const reshareCount = parseSafeInt(postObj?.text_post_app_info?.reshare_count, 0);

    let mediaType = 'text';
    const imageUrls = [];
    const videoUrl = postObj?.video_versions?.[0]?.url || ogMeta.video || undefined;

    if (videoUrl) {
        mediaType = 'video';
    } else if (Array.isArray(postObj?.carousel_media) && postObj.carousel_media.length > 0) {
        mediaType = 'carousel';
        for (const item of postObj.carousel_media) {
            const candidateUrl = item?.image_versions2?.candidates?.[0]?.url;
            if (candidateUrl) imageUrls.push(candidateUrl);
        }
    } else {
        const directImg = postObj?.image_versions2?.candidates?.[0]?.url;
        const ogImg = ogMeta.image && !/static\.cdninstagram\.com\/rsrc\.php/i.test(ogMeta.image) ? ogMeta.image : undefined;
        const chosenImg = directImg || ogImg;
        if (chosenImg) {
            mediaType = 'image';
            imageUrls.push(chosenImg);
        }
    }

    const resolvedUrl = postObj?.canonical_url
        || (author && postCode ? `https://www.threads.com/@${author}/post/${postCode}` : undefined)
        || (fallbackUrl && fallbackUrl.startsWith('http') ? fallbackUrl : (postCode ? `https://www.threads.com/post/${postCode}` : undefined));

    const emails = extractEmails(text);
    const phones = extractPhones(text);

    return sanitizeRecord({
        type: 'POST',
        id,
        postCode,
        url: resolvedUrl,
        username: author ? `@${author}` : undefined,
        text,
        likesCount,
        replyCount,
        repostCount,
        quoteCount,
        reshareCount,
        mediaType,
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
        videoUrl,
        email: emails[0],
        emails: emails.length > 0 ? emails : undefined,
        phone: phones[0],
        phones: phones.length > 0 ? phones : undefined,
        publishedAt: formatTakenAt(postObj?.taken_at),
        source: 'threads_html',
        scrapedAt: new Date().toISOString()
    });
}

// Parse Profile from HTML and embedded data
export function parseProfileHtml(html, url) {
    if (!html || typeof html !== 'string') return null;

    const usernameMatch = String(url || '').match(/@([a-zA-Z0-9_.-]+)/i);
    const fallbackUsername = usernameMatch ? usernameMatch[1] : undefined;
    const jsonBlocks = extractEmbeddedJson(html);

    let matchedUser = null;
    let firstUser = null;

    const inspectForUser = (obj) => {
        if (!obj || typeof obj !== 'object' || matchedUser) return;
        if (obj.username && (obj.follower_count !== undefined || obj.full_name !== undefined)) {
            if (!firstUser) firstUser = obj;
            if (!fallbackUsername || String(obj.username).toLowerCase() === fallbackUsername.toLowerCase()) {
                matchedUser = obj;
                return;
            }
        }
        if (Array.isArray(obj)) {
            for (const item of obj) {
                if (matchedUser) break;
                inspectForUser(item);
            }
        } else {
            for (const k of Object.keys(obj)) {
                if (matchedUser) break;
                inspectForUser(obj[k]);
            }
        }
    };

    for (const block of jsonBlocks) {
        inspectForUser(block);
        if (matchedUser) break;
    }

    const userObj = matchedUser || firstUser;
    const username = userObj?.username || fallbackUsername;
    if (!username) return null;

    const ogTitle = readMetaTag(html, 'og:title');
    const ogDesc = readMetaTag(html, 'og:description');
    const ogImage = readMetaTag(html, 'og:image');

    if (!userObj && (!ogTitle || ogTitle.trim().toLowerCase() === 'threads') && !ogDesc) {
        return null;
    }

    const displayName = userObj?.full_name
        || ogTitle?.split('(')[0]?.trim()
        || username;
    const bio = (userObj?.biography ?? ogDesc ?? '').trim();
    const profilePic = userObj?.hd_profile_pic_versions?.[0]?.url
        || userObj?.profile_pic_url
        || (ogImage && !/static\.cdninstagram\.com\/rsrc\.php/i.test(ogImage) ? ogImage : undefined);
    const isVerified = Boolean(userObj?.is_verified || html.includes('verified_badge'));

    let followersCount;
    let followersCountRaw = parseSafeInt(userObj?.follower_count, 0);

    if (!followersCountRaw) {
        const fMatch = html.match(/(\d[\d.,]*[KkMmBb]?)\s+followers/i);
        if (fMatch) {
            followersCount = fMatch[1];
            followersCountRaw = parseCount(followersCount);
        }
    } else {
        followersCount = followersCountRaw.toLocaleString();
    }

    const firstBioLink = Array.isArray(userObj?.bio_links) ? userObj.bio_links[0] : undefined;
    const externalLink = typeof firstBioLink === 'string'
        ? firstBioLink
        : (firstBioLink?.url || undefined);

    const emails = extractEmails(`${displayName} ${bio}`);
    const phones = extractPhones(`${displayName} ${bio}`);

    return sanitizeRecord({
        type: 'PROFILE',
        id: userObj?.id ? String(userObj.id) : (userObj?.pk ? String(userObj.pk) : username),
        username: `@${username}`,
        displayName,
        url: `https://www.threads.com/@${username}`,
        bio,
        followersCount: followersCount || '0',
        followersCountRaw,
        isVerified,
        profilePictureUrl: profilePic,
        externalLink,
        email: emails[0],
        emails: emails.length > 0 ? emails : undefined,
        phone: phones[0],
        phones: phones.length > 0 ? phones : undefined,
        source: 'threads_html',
        scrapedAt: new Date().toISOString()
    });
}

// Extract all unique embedded post objects (e.g., Search page or Profile feed) directly from HTML JSON
export function extractPostsFromHtml(html, options = {}) {
    if (!html || typeof html !== 'string') return [];
    const maxItems = options.maxItems ?? 50;
    const expectedAuthor = options.expectedAuthor ? String(options.expectedAuthor).replace(/^@/, '').toLowerCase() : null;
    const searchQuery = options.searchQuery || undefined;

    const jsonBlocks = extractEmbeddedJson(html);
    const rawPosts = [];

    const collectPosts = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj.thread_items)) {
            for (const ti of obj.thread_items) {
                if (ti?.post && typeof ti.post === 'object') {
                    rawPosts.push(ti.post);
                }
            }
        }
        if (obj.code && obj.user && (obj.caption !== undefined || obj.like_count !== undefined)) {
            rawPosts.push(obj);
        }
        if (Array.isArray(obj)) {
            for (const v of obj) collectPosts(v);
        } else {
            for (const k of Object.keys(obj)) collectPosts(obj[k]);
        }
    };

    for (const block of jsonBlocks) {
        collectPosts(block);
    }

    const seen = new Set();
    const extracted = [];

    for (const raw of rawPosts) {
        if (extracted.length >= maxItems) break;
        const key = String(raw.code || raw.id || raw.pk || '');
        if (!key || seen.has(key)) continue;

        if (expectedAuthor) {
            const postAuthor = String(raw.user?.username || '').toLowerCase();
            if (postAuthor && postAuthor !== expectedAuthor) continue;
        }

        const parsed = parsePostObject(raw);
        if (!parsed) continue;

        seen.add(key);
        if (searchQuery) parsed.searchQuery = searchQuery;
        extracted.push(sanitizeRecord(parsed));
    }

    return extracted;
}

// Parse a dedicated Thread Post page (root POST + embedded REPLY items)
export function parsePostAndRepliesHtml(html, url, options = {}) {
    if (!html || typeof html !== 'string') return { post: null, replies: [] };

    const maxReplies = options.maxReplies ?? 20;
    const postCodeMatch = String(url || '').match(/\/post\/([a-zA-Z0-9_-]+)/i);
    const targetCode = postCodeMatch ? postCodeMatch[1] : undefined;

    const ogMeta = {
        title: readMetaTag(html, 'og:title') || '',
        description: readMetaTag(html, 'og:description') || '',
        image: readMetaTag(html, 'og:image'),
        video: readMetaTag(html, 'og:video')
    };

    const jsonBlocks = extractEmbeddedJson(html);
    const allPostObjs = [];

    const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj.thread_items)) {
            for (const ti of obj.thread_items) {
                if (ti?.post && typeof ti.post === 'object') {
                    allPostObjs.push(ti.post);
                }
            }
        }
        if (obj.code && (obj.caption !== undefined || obj.like_count !== undefined)) {
            allPostObjs.push(obj);
        }
        if (Array.isArray(obj)) {
            for (const v of obj) walk(v);
        } else {
            for (const k of Object.keys(obj)) walk(obj[k]);
        }
    };

    for (const block of jsonBlocks) walk(block);

    let rootObj = allPostObjs.find(p => targetCode && p.code === targetCode) || allPostObjs[0] || null;
    const rootPost = parsePostObject(rootObj, url, ogMeta);
    const resolvedRootCode = rootPost?.postCode || targetCode;

    const replies = [];
    const seenReplies = new Set();

    if (maxReplies > 0) {
        for (const p of allPostObjs) {
            if (replies.length >= maxReplies) break;
            const code = p?.code ? String(p.code) : '';
            if (!code || code === resolvedRootCode || seenReplies.has(code)) continue;
            seenReplies.add(code);

            const parsed = parsePostObject(p);
            if (!parsed) continue;

            replies.push(sanitizeRecord({
                type: 'REPLY',
                id: parsed.id,
                postCode: code,
                parentPostCode: resolvedRootCode,
                url: parsed.url,
                username: parsed.username,
                replyAuthor: parsed.username,
                replyText: parsed.text,
                text: parsed.text,
                likesCount: parsed.likesCount,
                replyCount: parsed.replyCount,
                repostCount: parsed.repostCount,
                mediaType: parsed.mediaType,
                imageUrls: parsed.imageUrls,
                videoUrl: parsed.videoUrl,
                publishedAt: parsed.publishedAt,
                source: 'threads_html',
                scrapedAt: parsed.scrapedAt
            }));
        }
    }

    return { post: rootPost, replies };
}

// Backward-compatible wrapper returning single POST record
export function parsePostHtml(html, url) {
    return parsePostAndRepliesHtml(html, url, { maxReplies: 0 }).post;
}
