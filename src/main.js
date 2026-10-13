import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';
import { PlaywrightCrawler, log } from 'crawlee';
import {
    parseProfileHtml,
    parsePostHtml
} from './extractors.js';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    mode = 'AUTO_DETECT',
    targetUrls = [],
    searchKeywords = [],
    maxPosts = 30,
    maxReplies = 20,
    proxyConfiguration
} = input;

log.info('🚀 Starting Threads (Meta) Ultimate Scraper...', {
    mode,
    targetUrlsCount: targetUrls.length,
    searchKeywordsCount: searchKeywords.length,
    maxPosts
});

const proxyConfig = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;

let urlsToProcess = [...targetUrls];
let keywordsToProcess = [...searchKeywords];

if (urlsToProcess.length === 0 && keywordsToProcess.length === 0) {
    urlsToProcess = [
        'https://www.threads.net/@zuck'
    ];
    log.info('ℹ️ No inputs provided. Defaulting to sample Threads target:', { urls: urlsToProcess });
}

function buildHeaders() {
    return {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1'
    };
}

// Fast HTML fetcher
async function fetchHtml(url) {
    const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
    const response = await gotScraping({
        url,
        headers: buildHeaders(),
        proxyUrl,
        timeout: { request: 25000 },
        retry: { limit: 2 }
    });
    return response.body;
}

// Playwright crawler fallback
async function fetchWithPlaywright(url) {
    let content = '';
    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxRequestsPerCrawl: 1,
        headless: true,
        requestHandlerTimeoutSecs: 35,
        async requestHandler({ page }) {
            // Dismiss cookie banner if present
            try {
                const acceptBtn = page.locator('button:has-text("Allow all cookies"), button:has-text("Accept")');
                if (await acceptBtn.isVisible({ timeout: 2000 })) {
                    await acceptBtn.click();
                }
            } catch (_) {}

            content = await page.content();
        }
    });
    await crawler.run([url]);
    return content;
}

function detectUrlMode(url, explicitMode) {
    if (explicitMode && explicitMode !== 'AUTO_DETECT') return explicitMode;
    const lower = url.toLowerCase();
    if (lower.includes('/post/')) return 'POSTS';
    return 'PROFILES';
}

const stats = {
    profiles: 0,
    posts: 0,
    searchResults: 0,
    failed: 0
};

// 1. PROCESS TARGET URLS
for (const rawUrl of urlsToProcess) {
    const url = rawUrl.trim();
    if (!url) continue;

    const currentMode = detectUrlMode(url, mode);
    log.info(`🎯 Processing [${currentMode}]: ${url}`);

    try {
        let html = '';
        try {
            html = await fetchHtml(url);
        } catch (fetchErr) {
            log.warning(`⚠️ HTTP fetch error for ${url} (${fetchErr.message}). Fallback to browser...`);
            html = await fetchWithPlaywright(url);
        }

        // POST MODE
        if (currentMode === 'POSTS') {
            const post = parsePostHtml(html, url);
            if (post) {
                await Actor.pushData(post);
                stats.posts++;
                log.info(`✅ Successfully scraped Thread Post: "${post.text.slice(0, 40)}..." [Likes: ${post.likesCount}, Replies: ${post.replyCount}]`);
            } else {
                log.warning(`⚠️ Could not parse post content from ${url}`);
            }
        }

        // PROFILE MODE
        else {
            const profile = parseProfileHtml(html, url);
            if (profile) {
                await Actor.pushData(profile);
                stats.profiles++;
                log.info(`✅ Successfully scraped Creator Profile: ${profile.displayName} (${profile.username}) [Followers: ${profile.followersCount}]`);
            } else {
                log.warning(`⚠️ Could not parse profile details from ${url}`);
            }
        }

    } catch (err) {
        log.error(`❌ Error scraping ${url}: ${err.message}`);
        stats.failed++;
    }
}

// 2. PROCESS SEARCH KEYWORDS
if (keywordsToProcess.length > 0) {
    for (const keyword of keywordsToProcess) {
        log.info(`🔍 Searching Threads for: "${keyword}"`);
        try {
            const searchUrl = `https://www.threads.net/search?q=${encodeURIComponent(keyword)}&serp_type=default`;
            let html = '';
            try {
                html = await fetchHtml(searchUrl);
            } catch (_) {
                html = await fetchWithPlaywright(searchUrl);
            }

            const postMatches = html.match(/\/post\/([a-zA-Z0-9_-]+)/g) || [];
            const uniquePostCodes = [...new Set(postMatches)].slice(0, maxPosts);

            log.info(`🔗 Discovered ${uniquePostCodes.length} candidate thread posts for "${keyword}"`);

            for (const postPath of uniquePostCodes) {
                const pUrl = `https://www.threads.net${postPath}`;
                try {
                    const pHtml = await fetchHtml(pUrl);
                    const post = parsePostHtml(pHtml, pUrl);
                    if (post) {
                        post.searchQuery = keyword;
                        await Actor.pushData(post);
                        stats.searchResults++;
                    }
                } catch (_) {}
            }

            log.info(`✅ Finished search for "${keyword}". Extracted ${stats.searchResults} posts.`);
        } catch (err) {
            log.error(`❌ Search failed for "${keyword}": ${err.message}`);
            stats.failed++;
        }
    }
}

// Save summary report
const summary = {
    status: 'COMPLETED',
    timestamp: new Date().toISOString(),
    metrics: stats,
    totalRecordsExtracted: stats.profiles + stats.posts + stats.searchResults,
    message: 'Threads Ultimate Scraper completed successfully.'
};

await Actor.setValue('OUTPUT', summary);
log.info('🏁 Execution Finished. Executive Summary:', summary);

await Actor.exit();
