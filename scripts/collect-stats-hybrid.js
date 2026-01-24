/**
 * Collect LinkedIn Stats (Hybrid Method)
 * Uses Playwright to establish a secure browser session, then executes API calls.
 * Best of both worlds: API speed + Browser security bypass.
 */

const { chromium } = require('playwright');
const sheets = require('./sheets-helper');

async function main() {
    console.log('Starting LinkedIn stats collection (Hybrid)...');

    const cookie = process.env.LINKEDIN_SESSION_COOKIE;
    if (!cookie) throw new Error('LINKEDIN_SESSION_COOKIE is required');

    let browser;
    try {
        browser = await chromium.launch({
            headless: true
        });

        // blocked resources to speed up initial load
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 }
        });

        // Add cookies
        const cookies = [{
            name: 'li_at',
            value: cookie.split(';')[0].replace('li_at=', '').trim(), // Ensure simple value if full string passed
            domain: '.linkedin.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None'
        }];

        // If JSESSIONID is in the env var (it should be for strict security), add it too
        const jsessionMatch = cookie.match(/JSESSIONID="?([^";]+)"?/);
        if (jsessionMatch) {
            cookies.push({
                name: 'JSESSIONID',
                value: jsessionMatch[1],
                domain: '.linkedin.com',
                path: '/',
                secure: true
            });
        }

        await context.addCookies(cookies);

        const page = await context.newPage();

        // Block heavy resources (images, media, fonts) but ALLOW CSS/JS/XHR to ensure page loads correctly
        await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,eot,mp4,mp3}', route => route.abort());

        console.log('Navigating to LinkedIn to establish session...');
        try {
            // We just need to hit the domain to set the session state
            // waitUntil: 'commit' is faster/safer if we just want to establish context
            await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e) {
            console.log(`Navigation partial error (${e.message}), waiting for stability...`);
        }

        // Wait for stability
        await page.waitForTimeout(5000);

        console.log('Session established. Fetching "Me" profile for URN...');

        // Execute fetch inside the browser context
        const me = await page.evaluate(async () => {
            const res = await fetch('https://www.linkedin.com/voyager/api/me', {
                headers: { 'x-li-lang': 'en_US', 'accept': 'application/vnd.linkedin.normalized+json+2.1' }
            });
            if (!res.ok) throw new Error(`Me API Status: ${res.status}`);
            return await res.json();
        });

        const entityUrn = me.miniProfile.entityUrn;
        console.log(`Logged in as: ${me.miniProfile.firstName}. URN: ${entityUrn}`);

        console.log('Fetching recent activity feed via internalized API...');
        const feedData = await page.evaluate(async (urn) => {
            const url = `https://www.linkedin.com/voyager/api/identity/profileUpdatesV2?count=40&includeLongTermHistory=true&moduleKey=member-shares:phone&q=memberShareFeed&start=0&profileUrn=${urn}`;
            const res = await fetch(url, {
                headers: { 'x-li-lang': 'en_US', 'accept': 'application/vnd.linkedin.normalized+json+2.1' }
            });
            if (!res.ok) throw new Error(`Feed API Status: ${res.status}`);
            return await res.json();
        }, entityUrn);

        // Process Data (Standard Node.js logic from here)
        console.log(`Feed fetched. Found ${feedData.elements ? feedData.elements.length : 0} items.`);

        const postStats = new Map();
        if (feedData.elements) {
            feedData.elements.forEach(item => {
                let urn = item.urn;
                let socialDetail = item.socialDetail;
                let commentary = item.commentary;

                if (socialDetail) {
                    const stats = {
                        likes: socialDetail.totalSocialActivityCounts?.numLikes || 0,
                        comments: socialDetail.totalSocialActivityCounts?.numComments || 0,
                        impressions: 0
                    };
                    if (urn) {
                        postStats.set(urn, stats);
                        const numericId = urn.split(':').pop();
                        postStats.set(numericId, stats);
                    }
                    if (commentary && commentary.text && commentary.text.text) {
                        const key = commentary.text.text.substring(0, 50).trim();
                        postStats.set(key, stats);
                    }
                }
            });
        }

        // --- Sheet Update Logic (Same as before) ---
        const postsNeedingStats = await sheets.getPostsNeedingStats('LinkedIn Posted');
        console.log(`${postsNeedingStats.length} posts in sheet need stats`);

        if (postsNeedingStats.length > 0) {
            const avgEngagement = await sheets.getAverageEngagement('LinkedIn Posted');
            let updatedCount = 0;

            for (const post of postsNeedingStats) {
                let match = null;
                // 1. Try URN match (ID)
                if (post.platformPostId) {
                    const id = post.platformPostId.split(':').pop();
                    match = postStats.get(id);
                    if (!match && postStats.has(post.platformPostId)) match = postStats.get(post.platformPostId);
                }
                // 2. Content match
                if (!match) {
                    const sheetContent = await sheets.getRawRows('LinkedIn Posted');
                    const rowData = sheetContent[post.rowIndex - 1];
                    const content = rowData ? rowData[1] : '';
                    if (content) {
                        const cleanContent = content.substring(0, 50).trim();
                        match = postStats.get(cleanContent);
                    }
                }

                if (match) {
                    const engagement = (match.likes || 0) + (match.comments || 0);
                    const isWinner = engagement > 0 && engagement >= (avgEngagement * 2);
                    console.log(`Row ${post.rowIndex}: Found Match! Eng=${engagement} ${isWinner ? '🏆' : ''}`);

                    await sheets.writeStats('LinkedIn Posted', post.rowIndex, {
                        impressions: match.impressions || 0,
                        engagement: engagement,
                        isWinner: isWinner
                    });
                    if (isWinner) {
                        try {
                            await sheets.copyRowToTab('LinkedIn Posted', 'LinkedIn Winners', post.rowIndex);
                        } catch (e) { console.error('Winner copy failed', e.message); }
                    }
                    updatedCount++;
                } else {
                    console.log(`Row ${post.rowIndex}: No match in recent feed.`);
                }
            }
            console.log(`Updated ${updatedCount} posts successfully.`);
        }

    } catch (error) {
        console.error('Hybrid execution failed:', error);
        // Take screenshot if page exists, might help debug
        if (browser) {
            // ... logic to save screenshot if needed
        }
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
}

main().catch(console.error);
