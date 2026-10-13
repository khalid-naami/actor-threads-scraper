/**
 * Threads Ultimate Scraper - Extractors & Parsers
 * High-speed parsing for Threads Profiles, Posts, Replies, and Media.
 */

// Helper to extract email addresses
export function extractEmails(text) {
    if (!text || typeof text !== 'string') return [];
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const matches = text.match(emailRegex) || [];
    const ignored = ['threads.net', 'instagram.com', 'fb.com', 'example.com'];
    const unique = [...new Set(matches.map(m => m.trim().toLowerCase()))];
    return unique.filter(e => !ignored.some(d => e.endsWith(`@${d}`)));
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

// Parse counts like "1.2M", "450K", "3,500"
export function parseCount(str) {
    if (!str) return 0;
    if (typeof str === 'number') return str;
    const text = String(str).trim().toUpperCase();

    let multiplier = 1;
    if (text.includes('M')) multiplier = 1_000_000;
    else if (text.includes('K')) multiplier = 1_000;

    const cleaned = text.replace(/[^0-9.]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : Math.round(num * multiplier);
}

// Extract JSON blocks embedded in data-sjs or script tags
export function extractEmbeddedJson(html) {
    if (!html) return [];
    const results = [];

    // Match <script type="application/json" ...>
    const scriptRegex = /<script[^>]+type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(html)) !== null) {
        try {
            const parsed = JSON.parse(match[1]);
            results.push(parsed);
        } catch (_) {}
    }

    return results;
}

// Parse Profile from HTML and embedded data
export function parseProfileHtml(html, url) {
    if (!html) return null;

    const usernameMatch = url.match(/@([a-zA-Z0-9_.-]+)/i);
    const fallbackUsername = usernameMatch ? usernameMatch[1] : null;

    // Search for user object in embedded JSON
    const jsonBlocks = extractEmbeddedJson(html);
    let userObj = null;

    for (const block of jsonBlocks) {
        const str = JSON.stringify(block);
        if (str.includes('"follower_count"') || str.includes('"full_name"')) {
            const findUser = (obj) => {
                if (!obj || typeof obj !== 'object') return;
                if (obj.username && (obj.follower_count !== undefined || obj.full_name !== undefined)) {
                    userObj = obj;
                    return;
                }
                for (const k of Object.keys(obj)) {
                    if (userObj) break;
                    findUser(obj[k]);
                }
            };
            findUser(block);
        }
        if (userObj) break;
    }

    const username = userObj?.username || fallbackUsername;
    const displayName = userObj?.full_name || html.match(/<meta property="og:title" content="([^"]*)"/i)?.[1]?.split('(')[0]?.trim() || username;
    const bio = userObj?.biography || html.match(/<meta property="og:description" content="([^"]*)"/i)?.[1] || '';
    const profilePic = userObj?.profile_pic_url || html.match(/<meta property="og:image" content="([^"]*)"/i)?.[1] || null;
    const isVerified = Boolean(userObj?.is_verified || html.includes('verified_badge') || html.includes('Verified'));

    let followersCount = null;
    let followersCountRaw = userObj?.follower_count || 0;

    if (!followersCountRaw) {
        const fMatch = html.match(/(\d[\d.,]*[KkMmBb]?)\s+followers/i);
        if (fMatch) {
            followersCount = fMatch[1];
            followersCountRaw = parseCount(followersCount);
        }
    } else {
        followersCount = followersCountRaw.toLocaleString();
    }

    const externalLink = userObj?.bio_links?.[0]?.url || null;
    const emails = extractEmails(`${displayName} ${bio}`);
    const phones = extractPhones(`${displayName} ${bio}`);

    return {
        type: 'PROFILE',
        id: userObj?.id || username,
        username: `@${username}`,
        displayName,
        url: `https://www.threads.net/@${username}`,
        bio,
        followersCount: followersCount || '0',
        followersCountRaw,
        isVerified,
        profilePictureUrl: profilePic,
        externalLink,
        email: emails[0] || null,
        emails: emails.length > 0 ? emails : undefined,
        phone: phones[0] || null,
        phones: phones.length > 0 ? phones : undefined,
        scrapedAt: new Date().toISOString()
    };
}

// Parse Thread Post from HTML and embedded data
export function parsePostHtml(html, url) {
    if (!html) return null;

    const postCodeMatch = url.match(/\/post\/([a-zA-Z0-9_-]+)/i);
    const postCode = postCodeMatch ? postCodeMatch[1] : null;

    // OpenGraph fallbacks
    const ogTitle = html.match(/<meta property="og:title" content="([^"]*)"/i)?.[1] || '';
    const ogDesc = html.match(/<meta property="og:description" content="([^"]*)"/i)?.[1] || '';
    const ogImage = html.match(/<meta property="og:image" content="([^"]*)"/i)?.[1] || null;
    const ogVideo = html.match(/<meta property="og:video" content="([^"]*)"/i)?.[1] || null;

    // Search for post object in embedded JSON
    const jsonBlocks = extractEmbeddedJson(html);
    let postObj = null;

    for (const block of jsonBlocks) {
        const str = JSON.stringify(block);
        if (str.includes('"caption"') || str.includes('"like_count"') || str.includes('"direct_reply_count"')) {
            const findPost = (obj) => {
                if (!obj || typeof obj !== 'object') return;
                if (obj.code === postCode || (obj.caption && obj.like_count !== undefined)) {
                    postObj = obj;
                    return;
                }
                for (const k of Object.keys(obj)) {
                    if (postObj) break;
                    findPost(obj[k]);
                }
            };
            findPost(block);
        }
        if (postObj) break;
    }

    const caption = postObj?.caption?.text || ogDesc;
    const author = postObj?.user?.username || url.match(/@([a-zA-Z0-9_.-]+)/)?.[1] || null;
    const likesCount = postObj?.like_count || 0;
    const replyCount = postObj?.text_post_app_info?.direct_reply_count || 0;
    const repostCount = postObj?.text_post_app_info?.repost_count || 0;

    let mediaType = 'text';
    const imageUrls = [];
    let videoUrl = postObj?.video_versions?.[0]?.url || ogVideo || null;

    if (videoUrl) {
        mediaType = 'video';
    } else if (postObj?.carousel_media) {
        mediaType = 'carousel';
        for (const item of postObj.carousel_media) {
            if (item.image_versions2?.candidates?.[0]?.url) {
                imageUrls.push(item.image_versions2.candidates[0].url);
            }
        }
    } else if (postObj?.image_versions2?.candidates?.[0]?.url || ogImage) {
        mediaType = 'image';
        imageUrls.push(postObj?.image_versions2?.candidates?.[0]?.url || ogImage);
    }

    const emails = extractEmails(caption);
    const phones = extractPhones(caption);

    return {
        type: 'POST',
        id: postObj?.id || postCode,
        postCode,
        url: url.startsWith('http') ? url : `https://www.threads.net/post/${postCode}`,
        username: author ? `@${author}` : undefined,
        text: caption,
        likesCount,
        replyCount,
        repostCount,
        mediaType,
        imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
        videoUrl: videoUrl || undefined,
        email: emails[0] || null,
        emails: emails.length > 0 ? emails : undefined,
        phones: phones.length > 0 ? phones : undefined,
        publishedAt: postObj?.taken_at ? new Date(postObj.taken_at * 1000).toISOString() : null,
        scrapedAt: new Date().toISOString()
    };
}
