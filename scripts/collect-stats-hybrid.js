/**
 * Collect LinkedIn Stats (Hybrid Method)
 * Uses Playwright to establish a secure browser session, then executes API calls.
 * Best of both worlds: API speed + Browser security bypass.
 */

const { chromium } = require('playwright');
const sheets = require('./sheets-helper');

async function main() {
    console.log('Starting LinkedIn stats collection (Hybrid - Navigation Mode)...');

    const cookie = process.env.LINKEDIN_SESSION_COOKIE;
    if (!cookie) throw new Error('LINKEDIN_SESSION_COOKIE is required');

    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox'
            ]
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
            locale: 'en-US',
            timezoneId: 'Africa/Johannesburg', // Match the user's likely location (SAST) to reduce suspicion
            geolocation: { longitude: 28.0473, latitude: -26.2041 }, // Johannesburg approximate
            permissions: ['geolocation']
        });

        // Evasion: Remove 'navigator.webdriver' property
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
        });

        // Add initial li_at cookie to start the session
        const initialCookies = [{
            name: 'li_at',
            value: cookie.split(';')[0].replace('li_at=', '').trim(),
            domain: '.linkedin.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None'
        }];

        await context.addCookies(initialCookies);
        const page = await context.newPage();

        // Block heavy resources
        await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,eot,mp4,mp3}', route => route.abort());

        console.log('Navigating to LinkedIn to generate valid session cookies...');
        try {
            await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e) {
            console.log(`Navigation note: ${e.message} (proceeding to check cookies)`);
        }

        // Wait for stability and cookie setting
        await page.waitForTimeout(5000);

        const finalUrl = page.url();
        console.log(`Navigation Complete. Current URL: ${finalUrl}`);

        if (!finalUrl.includes('feed') && !finalUrl.includes('linkedin.com/in/')) {
            console.warn('Warning: Did not land on Feed or Profile. Likely on a security checkpoint or login page.');
            // Take screenshot to artifact (base64) for debugging? 
            // For now just logging is enough.
        }

        // Harvest REAL cookies from the authenticated context
        const contextCookies = await context.cookies();
        const liAtCookie = contextCookies.find(c => c.name === 'li_at');
        const jSessionCookie = contextCookies.find(c => c.name === 'JSESSIONID');

        if (!jSessionCookie) {
            console.error('Available Cookies:', contextCookies.map(c => c.name));
            throw new Error('Failed to establish session: JSESSIONID missing after navigation.');
        }

        const csrfToken = jSessionCookie.value.replace(/"/g, '');
        console.log(`Session Active. CSRF Token: ${csrfToken.substring(0, 10)}...`);

        const headers = {
            'x-li-lang': 'en_US',
            'accept': 'application/vnd.linkedin.normalized+json+2.1',
            'Csrf-Token': csrfToken,
            // Reconstruct cookie string from the browser's valid set to ensure consistency
            'Cookie': contextCookies.map(c => `${c.name}=${c.value}`).join('; ')
        };

        const request = context.request;
        console.log('Sending API request via Playwright network stack...');

        const meRes = await request.get('https://www.linkedin.com/voyager/api/me', { headers });

        if (!meRes.ok()) {
            console.error(`Status: ${meRes.status()} ${meRes.statusText()}`);
            console.error(`Body: ${await meRes.text()}`);
            throw new Error('API Authentication Failed (Status ' + meRes.status() + ')');
        }

        const me = await meRes.json();
        const entityUrn = me.miniProfile.entityUrn;
        console.log(`Logged in as: ${me.miniProfile.firstName}. URN: ${entityUrn}`);

        console.log('Fetching recent activity feed...');
        const feedRes = await request.get(`https://www.linkedin.com/voyager/api/identity/profileUpdatesV2?count=40&includeLongTermHistory=true&moduleKey=member-shares:phone&q=memberShareFeed&start=0&profileUrn=${entityUrn}`, { headers });

        if (!feedRes.ok()) throw new Error(`Feed API Failed: ${feedRes.status()}`);

        const feedData = await feedRes.json();
        const postStats = new Map();

        console.log(`Feed fetched. Found ${feedData.elements ? feedData.elements.length : 0} items.`);

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

        // --- Sheet Update Logic ---
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
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
}

main().catch(console.error);
