/**
 * Collect LinkedIn Stats via Browser Automation
 * Uses Playwright to scrape post analytics from personal profile
 * 
 * SAFETY FEATURES:
 * - Human-like random delays between actions
 * - Slow scrolling with variable speeds
 * - Single daily run only
 * - Minimal page interactions
 * 
 * Requires: LINKEDIN_SESSION_COOKIE environment variable (li_at cookie value)
 */

const { chromium } = require('playwright');
const sheets = require('./sheets-helper');

const PROFILE_URL = 'https://www.linkedin.com/in/chad-van-der-walt-87b506314/recent-activity/all/';
const MAX_POSTS_TO_SCRAPE = 30; // Reduced to minimize exposure

// Human-like delay (random between min and max ms)
function humanDelay(minMs = 1000, maxMs = 3000) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise(resolve => setTimeout(resolve, delay));
}

async function main() {
    console.log('Starting LinkedIn browser stats collection (safe mode)...');
    console.log('Cookie received: ' + (process.env.LINKEDIN_SESSION_COOKIE ? 'Yes (hidden)' : 'No'));

    const sessionCookie = process.env.LINKEDIN_SESSION_COOKIE;
    if (!sessionCookie) {
        throw new Error('LINKEDIN_SESSION_COOKIE not set. Get your li_at cookie from browser.');
    }

    const browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--no-sandbox'
        ]
    });

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
            locale: 'en-US',
            timezoneId: 'Africa/Johannesburg'
        });

        // Set the session cookie
        await context.addCookies([{
            name: 'li_at',
            value: sessionCookie,
            domain: '.linkedin.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None'
        }]);

        const page = await context.newPage();

        // Human-like initial delay before navigation
        console.log('Preparing to navigate...');
        await humanDelay(1000, 2000);

        console.log('Navigating to recent activity...');
        await page.goto(PROFILE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Wait for page to settle (human-like)
        await humanDelay(3000, 5000);

        // Check if logged in
        const isLoggedIn = await page.locator('.feed-shared-update-v2').first().isVisible().catch(() => false);
        if (!isLoggedIn) {
            const loginButton = await page.locator('a[href*="login"]').isVisible().catch(() => false);
            if (loginButton) {
                throw new Error('Session cookie invalid or expired. Please get a fresh li_at cookie.');
            }
            console.log('No posts visible yet, waiting more...');
            await humanDelay(3000, 5000);
        }

        // Slow, human-like scrolling (3 scrolls only, with random delays)
        console.log('Scrolling slowly to load posts...');
        for (let i = 0; i < 3; i++) {
            // Scroll down by a random amount
            const scrollAmount = 600 + Math.floor(Math.random() * 400);
            await page.evaluate((amt) => window.scrollBy(0, amt), scrollAmount);
            await humanDelay(2000, 4000); // Random wait between scrolls
        }

        // Scrape posts
        console.log('Scraping post data...');

        const posts = await scrapePostStats(page);
        console.log(`Found ${posts.length} posts with stats`);
        console.log('Scraped URNs:', posts.map(p => p.urn).join(', '));


        if (posts.length === 0) {
            console.log('No posts found. Check if page loaded correctly.');
            await page.screenshot({ path: 'debug-screenshot.png' });
            return;
        }

        // Get posts needing stats from sheet
        const postsNeedingStats = await sheets.getPostsNeedingStats('LinkedIn Posted');
        console.log(`${postsNeedingStats.length} posts in sheet need stats`);

        if (postsNeedingStats.length === 0) {
            console.log('All posts already have stats collected.');
            return;
        }

        // Get average for winner calculation
        const avgEngagement = await sheets.getAverageEngagement('LinkedIn Posted');
        const winnerThreshold = avgEngagement > 0 ? avgEngagement * 2 : 10; // Default threshold if no avg yet
        console.log(`Winner threshold: ${winnerThreshold.toFixed(0)} engagement`);

        // Match and update stats
        let updatedCount = 0;
        for (const sheetPost of postsNeedingStats) {
            let match = null;

            // 1. Try matching by Platform Post ID (URN)
            if (sheetPost.platformPostId) {
                // sheetPost.platformPostId looks like "urn:li:share:12345"
                const sheetId = sheetPost.platformPostId.split(':').pop(); // Get last part (the number)
                console.log(`  Checking ID match for ${sheetId}...`);

                // Check main URN AND any deep URNs found
                match = posts.find(p => {
                    if (p.urn && p.urn.includes(sheetId)) return true;
                    if (p.deepUrns && p.deepUrns.some(u => u.includes(sheetId))) return true;
                    return false;
                });

                if (match) console.log(`  -> Matched by ID: ${sheetPost.platformPostId}`);
            }

            // 2. Fallback to Content Matching
            if (!match) {
                // Get post content from sheet to match
                const sheetContent = await getPostContent(sheetPost.rowIndex);
                if (sheetContent) {
                    console.log(`  Checking Content match for row ${sheetPost.rowIndex}...`);
                    match = findMatchingPost(sheetContent, posts);
                    if (match) console.log(`  -> Matched by Content: "${sheetContent.substring(0, 30)}..."`);
                    else console.log(`  -> No content match found for: "${sheetContent.substring(0, 30)}..."`);
                }
            }

            if (match) {
                const engagement = match.reactions + match.comments;
                const isWinner = engagement >= winnerThreshold;

                console.log(`  -> ${match.impressions} imp, ${engagement} eng ${isWinner ? '🏆' : ''}`);

                await sheets.writeStats('LinkedIn Posted', sheetPost.rowIndex, {
                    impressions: match.impressions,
                    engagement,
                    isWinner
                });

                if (isWinner) {
                    try {
                        await sheets.copyRowToTab('LinkedIn Posted', 'LinkedIn Winners', sheetPost.rowIndex);
                        console.log(`  -> 🏆 Winner moved to LinkedIn Winners`);
                    } catch (error) {
                        console.error(`  -> Failed to copy winner: ${error.message}`);
                    }
                }

                updatedCount++;
            }
        }

        console.log(`\nUpdated stats for ${updatedCount} posts`);

    } finally {
        await browser.close();
    }

    console.log('Stats collection complete!');
}

/**
 * Scrape post statistics from the page
 */
async function scrapePostStats(page) {
    const posts = [];

    // Get all post containers
    const postElements = await page.locator('.feed-shared-update-v2').all();
    console.log(`Found ${postElements.length} post elements`);

    for (let i = 0; i < Math.min(postElements.length, MAX_POSTS_TO_SCRAPE); i++) {
        try {
            const post = postElements[i];

            // Expand "See more" if present to get full text
            const seeMore = post.locator('.feed-shared-inline-show-more-text__see-more-less-toggle').first();
            if (await seeMore.isVisible().catch(() => false)) {
                await seeMore.click().catch(() => { });
                await page.waitForTimeout(500); // Short wait via page timeout instead of humanDelay for speed
            }

            // Get URN (Post ID)
            const urn = await post.getAttribute('data-urn').catch(() => null);

            // Get ALL attributes from the element and children to find nested IDs
            const deepUrns = await post.evaluate((el) => {
                const results = [];
                // Check all elements inside this post
                const all = el.querySelectorAll('*');
                for (const node of all) {
                    // Check common attributes for URNs
                    ['data-urn', 'data-id', 'id'].forEach(attr => {
                        if (node.hasAttribute(attr)) results.push(node.getAttribute(attr));
                    });
                    // Check hrefs
                    if (node.href && node.href.includes('urn:li:')) results.push(node.href);
                }
                return results;
            });

            // Get post text content
            const textContent = await post.locator('.feed-shared-update-v2__description, .break-words').first().textContent().catch(() => '');

            // Get reactions count
            const reactionsText = await post.locator('.social-details-social-counts__reactions-count').textContent().catch(() => '0');
            const reactions = parseMetricNumber(reactionsText);

            // Get comments count
            const commentsText = await post.locator('button[aria-label*="comment"], .social-details-social-counts__comments').textContent().catch(() => '0');
            const comments = parseMetricNumber(commentsText);

            // Get impressions
            let impressions = 0;
            const analyticsButton = await post.locator('[aria-label*="impression"], .analytics-entry-point').first();
            if (await analyticsButton.isVisible().catch(() => false)) {
                const impText = await analyticsButton.textContent().catch(() => '0');
                impressions = parseMetricNumber(impText);
            }

            if (impressions === 0) {
                const impAlt = await post.locator('.social-details-social-counts__item--impressions').textContent().catch(() => '0');
                impressions = parseMetricNumber(impAlt);
            }

            if (textContent.trim()) {
                posts.push({
                    urn: urn,
                    deepUrns, // Store deep URNs for checking
                    content: textContent.trim(), // Full content now
                    impressions,
                    reactions,
                    comments
                });
            }
        } catch (error) {
            console.error(`Error scraping post ${i}:`, error.message);
        }
    }

    return posts;
}

/**
 * Parse LinkedIn's metric format (e.g., "1,234" or "1.2K" or "1M")
 */
function parseMetricNumber(str) {
    if (!str) return 0;
    str = str.replace(/[,\s]/g, '').toLowerCase();

    const match = str.match(/([\d.]+)\s*(k|m)?/);
    if (!match) return 0;

    let num = parseFloat(match[1]);
    if (match[2] === 'k') num *= 1000;
    if (match[2] === 'm') num *= 1000000;

    return Math.round(num);
}

/**
 * Get post content from sheet for matching
 */
async function getPostContent(rowIndex) {
    const rows = await sheets.getRawRows('LinkedIn Posted');
    if (rowIndex > rows.length) return null;

    const headers = rows[0];
    const contentIdx = headers.indexOf('Content');
    if (contentIdx < 0) return null;

    return rows[rowIndex - 1]?.[contentIdx] || null;
}

/**
 * Find matching scraped post by content similarity
 */
function findMatchingPost(sheetContent, scrapedPosts) {
    if (!sheetContent) return null;
    const normalizedSheet = normalizeText(sheetContent);

    for (const post of scrapedPosts) {
        const normalizedScraped = normalizeText(post.content);

        // Check if first 50 chars match (accounting for LinkedIn's text formatting)
        if (normalizedSheet.substring(0, 50) === normalizedScraped.substring(0, 50)) {
            return post;
        }

        // Fuzzy match - check if 80% of words match
        const sheetWords = normalizedSheet.split(/\s+/).slice(0, 20);
        const scrapedWords = normalizedScraped.split(/\s+/).slice(0, 20);

        if (sheetWords.length === 0) continue;

        const matchCount = sheetWords.filter(w => scrapedWords.includes(w)).length;
        if (matchCount / sheetWords.length >= 0.8) {
            return post;
        }
    }

    return null;
}

/**
 * Normalize text for comparison
 */
function normalizeText(text) {
    if (!text) return '';
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

main().catch(error => {
    console.error('Fatal error:', error.message);
    process.exit(1);
});
