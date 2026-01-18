/**
 * Collect Stats
 * Pulls engagement metrics for posts that are 24+ hours old
 * Flags winners (2x average engagement)
 */

const { TwitterApi } = require('twitter-api-v2');
const sheets = require('./sheets-helper');

async function main() {
    console.log('Starting stats collection...');

    // Collect X stats
    await collectXStats();

    // Collect LinkedIn stats
    await collectLinkedInStats();

    console.log('Stats collection complete!');
}

async function collectXStats() {
    console.log('\n--- Collecting X Stats ---');

    const client = new TwitterApi({
        appKey: process.env.X_API_KEY,
        appSecret: process.env.X_API_SECRET,
        accessToken: process.env.X_ACCESS_TOKEN,
        accessSecret: process.env.X_ACCESS_SECRET
    });

    // Get posts needing stats
    const posts = await sheets.getPostsNeedingStats('X Posted');
    console.log(`Found ${posts.length} posts needing stats`);

    if (posts.length === 0) return;

    // Get average for winner calculation
    const avgEngagement = await sheets.getAverageEngagement('X Posted');
    const winnerThreshold = avgEngagement * 2;
    console.log(`Average engagement: ${avgEngagement.toFixed(0)}, Winner threshold: ${winnerThreshold.toFixed(0)}`);

    for (const post of posts) {
        try {
            // Get tweet metrics
            const tweet = await client.v2.singleTweet(post.platformPostId, {
                'tweet.fields': ['public_metrics']
            });

            const metrics = tweet.data.public_metrics;
            const engagement = (metrics.like_count || 0) +
                (metrics.retweet_count || 0) +
                (metrics.reply_count || 0) +
                (metrics.quote_count || 0);

            const isWinner = engagement >= winnerThreshold;

            console.log(`Tweet ${post.platformPostId}: ${metrics.impression_count} impressions, ${engagement} engagement ${isWinner ? '🏆' : ''}`);

            await sheets.writeStats('X Posted', post.rowIndex, {
                impressions: metrics.impression_count || 0,
                engagement,
                isWinner
            });

            await sleep(1000);

        } catch (error) {
            console.error(`Failed to get stats for ${post.platformPostId}:`, error.message);
        }
    }
}

async function collectLinkedInStats() {
    console.log('\n--- Collecting LinkedIn Stats ---');

    const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
    if (!accessToken) {
        console.log('No LinkedIn access token, skipping...');
        return;
    }

    // Get posts needing stats
    const posts = await sheets.getPostsNeedingStats('LinkedIn Posted');
    console.log(`Found ${posts.length} posts needing stats`);

    if (posts.length === 0) return;

    // Get average for winner calculation
    const avgEngagement = await sheets.getAverageEngagement('LinkedIn Posted');
    const winnerThreshold = avgEngagement * 2;
    console.log(`Average engagement: ${avgEngagement.toFixed(0)}, Winner threshold: ${winnerThreshold.toFixed(0)}`);

    for (const post of posts) {
        try {
            // LinkedIn stats API
            const response = await fetch(
                `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(post.platformPostId)}`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'X-Restli-Protocol-Version': '2.0.0'
                    }
                }
            );

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const data = await response.json();
            const engagement = (data.likesSummary?.totalLikes || 0) +
                (data.commentsSummary?.totalFirstLevelComments || 0);

            // LinkedIn doesn't easily expose impressions via API
            // We'll estimate or leave as 0
            const isWinner = engagement >= winnerThreshold;

            console.log(`Post ${post.platformPostId}: ${engagement} engagement ${isWinner ? '🏆' : ''}`);

            await sheets.writeStats('LinkedIn Posted', post.rowIndex, {
                impressions: 0, // LinkedIn API limitation
                engagement,
                isWinner
            });

            await sleep(1000);

        } catch (error) {
            console.error(`Failed to get stats for ${post.platformPostId}:`, error.message);
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
