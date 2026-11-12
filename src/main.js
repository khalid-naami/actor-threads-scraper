import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';
import { PlaywrightCrawler, log } from 'crawlee';
import {
    sanitizeRecord,
    normalizeThreadsUrl,
    detectThreadsUrlType,
    extractSearchKeywordFromUrl,
    detectThreadsBlock,
    parseProfileHtml,
    parsePostHtml,
    parsePostAndRepliesHtml,
    extractPostsFromHtml
} from './extractors.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await Actor.init();

const diagnostics = [];
function addDiagnostic(msg) {
    if (msg && !diagnostics.includes(msg)) {
        diagnostics.push(msg);
    }
}

try {
    const input = (await Actor.getInput()) || {};
    const {
        mode = 'AUTO_DETECT',
        targetUrls = [],
        searchKeywords = [],
        maxPosts = 30,
        maxReplies = 20,
        proxyConfiguration
    } = input;

    const isResidentialProxy = Boolean(
        proxyConfiguration?.useApifyProxy &&
        Array.isArray(proxyConfiguration.apifyProxyGroups) &&
        proxyConfiguration.apifyProxyGroups.some((g) => /residential/i.test(String(g)))
    );

    log.info('🚀 Starting Threads (Meta) Ultimate Scraper...', {
        mode,
        targetUrlsCount: Array.isArray(targetUrls) ? targetUrls.length : 0,
        searchKeywordsCount: Array.isArray(searchKeywords) ? searchKeywords.length : 0,
        maxPosts,
        maxReplies,
        isResidentialProxy
    });

    let proxyConfig;
    if (proxyConfiguration) {
        try {
            proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
        } catch (err) {
            log.warning(`⚠️ Proxy initialization failed (${err.message}). Continuing without Apify proxy.`);
            addDiagnostic(`Proxy initialization skipped: ${err.message}`);
            proxyConfig = undefined;
        }
    }

    let rawTargets = Array.isArray(targetUrls) ? [...targetUrls] : [];
    const keywordsQueue = Array.isArray(searchKeywords)
        ? searchKeywords.map((k) => String(k || '').trim()).filter(Boolean)
        : [];

    if (rawTargets.length === 0 && keywordsQueue.length === 0) {
        rawTargets = ['https://www.threads.com/@zuck'];
        log.info('ℹ️ No inputs provided. Defaulting to sample Threads target:', { urls: rawTargets });
    }

    const stats = {
        profiles: 0,
        posts: 0,
        replies: 0,
        searchResults: 0,
        failed: 0
    };

    const state = {
        pwRunSeq: 0,
        playwrightChallengeBlocked: false
    };

    async function getProxyUrl() {
        return proxyConfig ? await proxyConfig.newUrl() : undefined;
    }

    // Tier 1: Fast gotScraping HTML fetcher with proxy rotation & block detection
    async function fetchHtmlViaGot(url) {
        const maxAttempts = proxyConfig ? 3 : 1;
        let lastFailure = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const proxyUrl = await getProxyUrl();
            const res = await gotScraping({
                url,
                headerGeneratorOptions: {
                    browsers: [{ name: 'chrome', minVersion: 124 }],
                    operatingSystems: ['windows', 'macos']
                },
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Upgrade-Insecure-Requests': '1'
                },
                proxyUrl,
                responseType: 'text',
                throwHttpErrors: false,
                timeout: { request: 25000 },
                retry: { limit: 0 }
            });

            if (res.statusCode === 429 && attempt + 1 < maxAttempts) {
                log.warning('⏳ Rate-limited (HTTP 429) by Threads. Rotating proxy and waiting 3s...');
                await sleep(3000);
                continue;
            }

            const block = detectThreadsBlock({
                statusCode: res.statusCode,
                body: res.body,
                finalUrl: res.url
            });

            if (!block.blocked) {
                return { ok: true, html: res.body, finalUrl: res.url, source: 'got_html' };
            }

            lastFailure = { ok: false, block, reason: block.reason };
            if (!block.retryable && block.statusCode !== 403) {
                break;
            }
        }

        return lastFailure || { ok: false, reason: 'HTTP fetch failed for Threads' };
    }

    // Tier 2: Crawlee 3.16 compatible Playwright fallback (unique RequestQueue + challenge detection)
    async function fetchHtmlWithPlaywright(targetUrl) {
        if (state.playwrightChallengeBlocked && !proxyConfig) {
            return {
                ok: false,
                reason: 'Threads previously returned Meta verification/challenge without proxies'
            };
        }

        let outcome = { ok: false, reason: 'Playwright did not produce HTML content' };
        const queueName = `threads-pw-${Date.now()}-${++state.pwRunSeq}`;
        const requestQueue = await Actor.openRequestQueue(queueName);

        try {
            await requestQueue.addRequest({ url: targetUrl });

            const crawler = new PlaywrightCrawler({
                requestQueue,
                proxyConfiguration: proxyConfig,
                maxRequestRetries: proxyConfig ? 2 : 0,
                headless: true,
                navigationTimeoutSecs: 35,
                requestHandlerTimeoutSecs: 45,
                preNavigationHooks: [
                    async (crawlingContext, hookGotoOptions) => {
                        const { page } = crawlingContext;
                        const gotoOptions = crawlingContext.gotoOptions ?? hookGotoOptions;
                        if (gotoOptions) {
                            gotoOptions.waitUntil = 'domcontentloaded';
                            gotoOptions.timeout = 35000;
                        }
                        await page.route('**/*.{woff,woff2,mp4,webm,m4v,avi}', (route) => route.abort().catch(() => {}));
                    }
                ],
                async requestHandler({ page, response }) {
                    const statusCode = response?.status() ?? 200;
                    const finalUrl = page.url();

                    try {
                        const acceptBtn = page.locator('button:has-text("Allow all cookies"), button:has-text("Accept")').first();
                        if (await acceptBtn.isVisible({ timeout: 2000 })) {
                            await acceptBtn.click().catch(() => {});
                        }
                    } catch (_) {}

                    await page.waitForTimeout(1500);
                    const html = await page.content();

                    const block = detectThreadsBlock({
                        statusCode,
                        body: html,
                        finalUrl
                    });

                    if (block.blocked) {
                        if (block.challenge && !proxyConfig) {
                            state.playwrightChallengeBlocked = true;
                        }
                        outcome = { ok: false, block, reason: block.reason };
                        return;
                    }

                    // Capture rendered post links if client-side hydrated dynamically
                    const domPostLinks = await page.evaluate(() => {
                        const links = [];
                        document.querySelectorAll('a[href*="/post/"]').forEach((a) => {
                            const href = a.getAttribute('href');
                            if (href) links.push(href);
                        });
                        return [...new Set(links)];
                    }).catch(() => []);

                    outcome = {
                        ok: true,
                        html,
                        finalUrl,
                        domPostLinks,
                        source: 'playwright_html'
                    };
                },
                failedRequestHandler({ request }, err) {
                    outcome = { ok: false, reason: `Playwright failed on ${request.url}: ${err.message}` };
                }
            });

            await crawler.run();
        } finally {
            await requestQueue.drop().catch(() => {});
        }

        return outcome;
    }

    async function fetchThreadsPage(url) {
        const gotRes = await fetchHtmlViaGot(url);
        if (gotRes.ok) {
            return gotRes;
        }

        log.warning(`⚠️ HTTP fetch blocked/failed for ${url} (${gotRes.reason}). Trying Playwright fallback...`);
        const pwRes = await fetchHtmlWithPlaywright(url);
        if (pwRes.ok) {
            return pwRes;
        }

        throw new Error(`HTTP (${gotRes.reason}), Playwright (${pwRes.reason})`);
    }

    // Helper: Scrape a post page and emit POST (+ optional REPLY records in REPLIES mode)
    async function processPostPage(postUrl, { emitRepliesSeparately = false } = {}) {
        const pageRes = await fetchThreadsPage(postUrl);
        const { post, replies } = parsePostAndRepliesHtml(pageRes.html, postUrl, { maxReplies });
        if (!post && replies.length === 0) {
            throw new Error(`Could not extract Threads post data from ${postUrl}`);
        }

        let pushed = 0;
        if (post) {
            post.source = pageRes.source;
            if (!emitRepliesSeparately && maxReplies > 0 && replies.length > 0) {
                post.replies = replies.map((r) => sanitizeRecord({
                    id: r.id,
                    postCode: r.postCode,
                    username: r.replyAuthor,
                    text: r.replyText,
                    likesCount: r.likesCount,
                    url: r.url,
                    publishedAt: r.publishedAt
                }));
            }
            await Actor.pushData(sanitizeRecord(post));
            stats.posts++;
            pushed++;
            log.info(`✅ Scraped Thread Post: "${(post.text || '').slice(0, 50)}" [Likes: ${post.likesCount || 0}, Replies: ${post.replyCount || 0}]`);
        }

        if (emitRepliesSeparately && maxReplies > 0) {
            for (const reply of replies) {
                reply.source = pageRes.source;
                await Actor.pushData(sanitizeRecord(reply));
                stats.replies++;
                pushed++;
            }
            log.info(`💬 Scraped ${replies.length} thread replies from ${postUrl}`);
        }

        return pushed;
    }

    // 1. PROCESS TARGET URLS
    for (const rawItem of rawTargets) {
        const url = normalizeThreadsUrl(rawItem);
        if (!url) {
            log.warning('⚠️ Skipping invalid Threads URL:', { rawItem });
            addDiagnostic(`Invalid Threads target URL skipped: ${JSON.stringify(rawItem)}`);
            stats.failed++;
            continue;
        }

        const currentMode = detectThreadsUrlType(url, mode);
        log.info(`🎯 Processing [${currentMode}]: ${url}`);

        try {
            if (currentMode === 'SEARCH') {
                const q = extractSearchKeywordFromUrl(url);
                if (!q) throw new Error(`Search URL missing ?q= parameter: ${url}`);
                keywordsQueue.push(q);
                continue;
            }

            if (currentMode === 'POSTS') {
                if (url.includes('/post/')) {
                    await processPostPage(url, { emitRepliesSeparately: false });
                } else {
                    const pageRes = await fetchThreadsPage(url);
                    const authorHandle = url.match(/@([a-zA-Z0-9_.-]+)/i)?.[1] || null;
                    const posts = extractPostsFromHtml(pageRes.html, {
                        maxItems: maxPosts,
                        expectedAuthor: authorHandle
                    });
                    if (posts.length === 0) {
                        throw new Error(`No posts found on ${url}`);
                    }
                    for (const p of posts) {
                        p.source = pageRes.source;
                        await Actor.pushData(sanitizeRecord(p));
                        stats.posts++;
                    }
                    log.info(`✅ Scraped ${posts.length} posts from ${url}`);
                }
            } else if (currentMode === 'REPLIES') {
                if (url.includes('/post/')) {
                    await processPostPage(url, { emitRepliesSeparately: true });
                } else {
                    const pageRes = await fetchThreadsPage(url);
                    const authorHandle = url.match(/@([a-zA-Z0-9_.-]+)/i)?.[1] || null;
                    const profilePosts = extractPostsFromHtml(pageRes.html, {
                        maxItems: Math.min(5, maxPosts),
                        expectedAuthor: authorHandle
                    });
                    if (profilePosts.length === 0) {
                        throw new Error(`No posts found on profile ${url} to extract replies from`);
                    }
                    for (const p of profilePosts) {
                        if (p.url) {
                            await processPostPage(p.url, { emitRepliesSeparately: true });
                        }
                    }
                }
            } else {
                // PROFILES mode
                const pageRes = await fetchThreadsPage(url);
                const profile = parseProfileHtml(pageRes.html, url);
                if (!profile) {
                    throw new Error(`Could not parse Threads profile metadata from ${url}`);
                }
                profile.source = pageRes.source;
                await Actor.pushData(sanitizeRecord(profile));
                stats.profiles++;
                log.info(`✅ Scraped Creator Profile: ${profile.displayName} (${profile.username}) [Followers: ${profile.followersCount}]`);

                if (maxPosts > 0) {
                    const recentPosts = extractPostsFromHtml(pageRes.html, {
                        maxItems: maxPosts,
                        expectedAuthor: profile.username
                    });
                    for (const post of recentPosts) {
                        post.source = pageRes.source;
                        await Actor.pushData(sanitizeRecord(post));
                        stats.posts++;
                    }
                    if (recentPosts.length > 0) {
                        log.info(`🧵 Extracted ${recentPosts.length} recent thread posts for ${profile.username}`);
                    }
                }
            }
        } catch (err) {
            log.error(`❌ Error scraping ${url}: ${err.message}`);
            addDiagnostic(`${url} -> ${err.message}`);
            stats.failed++;
        }
    }

    // 2. PROCESS SEARCH KEYWORDS
    for (const keyword of keywordsQueue) {
        log.info(`🔍 Searching Threads for: "${keyword}"`);
        try {
            const searchUrl = `https://www.threads.com/search?q=${encodeURIComponent(keyword)}&serp_type=default`;
            const searchRes = await fetchThreadsPage(searchUrl);

            // Step A: Extract rich embedded JSON search posts directly from Search HTML
            const embeddedPosts = extractPostsFromHtml(searchRes.html, {
                maxItems: maxPosts,
                searchQuery: keyword
            });

            const seenCodes = new Set();
            let keywordCount = 0;

            for (const post of embeddedPosts) {
                if (keywordCount >= maxPosts) break;
                const key = post.postCode || post.id;
                if (key) seenCodes.add(key);
                post.source = searchRes.source;
                await Actor.pushData(sanitizeRecord(post));
                keywordCount++;
                stats.searchResults++;
            }

            // Step B: Hydrate any remaining candidate /post/... URLs only if embedded JSON had fewer than maxPosts
            if (keywordCount < maxPosts) {
                const regexLinks = searchRes.html.match(/\/(?:@[a-zA-Z0-9_.-]+\/)?post\/[a-zA-Z0-9_-]+/g) || [];
                const domLinks = Array.isArray(searchRes.domPostLinks) ? searchRes.domPostLinks : [];
                const allCandidatePaths = [...new Set([...regexLinks, ...domLinks])];

                log.info(`🔗 Embedded JSON yielded ${keywordCount} posts; checking ${allCandidatePaths.length} candidate links for remaining quota...`);

                for (const postPath of allCandidatePaths) {
                    if (keywordCount >= maxPosts) break;
                    const code = postPath.match(/\/post\/([a-zA-Z0-9_-]+)/i)?.[1];
                    if (code && seenCodes.has(code)) continue;

                    const pUrl = postPath.startsWith('http')
                        ? postPath
                        : `https://www.threads.com${postPath.startsWith('/') ? '' : '/'}${postPath}`;

                    try {
                        const pRes = await fetchThreadsPage(pUrl);
                        const post = parsePostHtml(pRes.html, pUrl);
                        if (post) {
                            if (code) seenCodes.add(code);
                            post.searchQuery = keyword;
                            post.source = pRes.source;
                            await Actor.pushData(sanitizeRecord(post));
                            keywordCount++;
                            stats.searchResults++;
                        }
                    } catch (postErr) {
                        log.warning(`⚠️ Failed candidate post ${pUrl}: ${postErr.message}`);
                    }
                }
            }

            if (keywordCount === 0) {
                log.warning(`⚠️ Search returned 0 posts for "${keyword}". Meta may require authenticated cookies/Residential proxy for Search results on this IP.`);
                addDiagnostic(`Search "${keyword}" returned 0 extractable posts.`);
                stats.failed++;
            } else {
                log.info(`✅ Finished search for "${keyword}". Extracted ${keywordCount} posts.`);
            }
        } catch (err) {
            log.error(`❌ Search failed for "${keyword}": ${err.message}`);
            addDiagnostic(`Search "${keyword}" -> ${err.message}`);
            stats.failed++;
        }
    }

    const totalRecordsExtracted = stats.profiles + stats.posts + stats.replies + stats.searchResults;
    const status = totalRecordsExtracted === 0
        ? 'FAILED'
        : (stats.failed > 0 ? 'PARTIAL_SUCCESS' : 'COMPLETED');

    const summary = {
        status,
        timestamp: new Date().toISOString(),
        metrics: stats,
        totalRecordsExtracted,
        diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
        message: totalRecordsExtracted === 0
            ? 'Threads Ultimate Scraper extracted 0 records. See diagnostics for details.'
            : (stats.failed > 0
                ? 'Threads Ultimate Scraper completed with partial failures (check diagnostics).'
                : 'Threads Ultimate Scraper completed successfully.')
    };

    await Actor.setValue('OUTPUT', summary);
    log.info('🏁 Execution Finished. Executive Summary:', summary);

    if (totalRecordsExtracted === 0) {
        const reasonSummary = diagnostics[0] || 'All targets failed or returned 0 extractable records.';
        await Actor.fail(`Extracted 0 Threads records. ${reasonSummary}`);
    } else {
        await Actor.exit();
    }
} catch (fatalErr) {
    log.error(`💥 Fatal Actor error: ${fatalErr.message}`, { stack: fatalErr.stack });
    await Actor.setValue('OUTPUT', {
        status: 'FAILED',
        timestamp: new Date().toISOString(),
        totalRecordsExtracted: 0,
        diagnostics: [fatalErr.message, ...diagnostics],
        message: `Fatal error: ${fatalErr.message}`
    }).catch(() => {});
    await Actor.fail(fatalErr.message);
}
