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
            // Use the memberCreatorPostAnalytics API for proper stats
            // The post ID format is urn:li:ugcPost:123 or urn:li:share:123
            const postUrn = post.platformPostId;

            // Fetch impressions
            const impressions = await fetchLinkedInMetric(accessToken, postUrn, 'IMPRESSION');

            // Fetch reactions (likes)
            const reactions = await fetchLinkedInMetric(accessToken, postUrn, 'REACTION');

            // Fetch comments
            const comments = await fetchLinkedInMetric(accessToken, postUrn, 'COMMENT');

            const engagement = reactions + comments;
            const isWinner = engagement >= winnerThreshold || (avgEngagement === 0 && engagement > 0);

            console.log(`Post ${postUrn}: ${impressions} impressions, ${engagement} engagement (${reactions} reactions, ${comments} comments) ${isWinner ? '🏆' : ''}`);

            await sheets.writeStats('LinkedIn Posted', post.rowIndex, {
                impressions,
                engagement,
                isWinner
            });

            await sleep(1500); // Slightly longer delay for LinkedIn rate limits

        } catch (error) {
            console.error(`Failed to get stats for ${post.platformPostId}:`, error.message);

            // If the new API fails, fallback to trying socialActions (legacy)
            try {
                const fallbackStats = await fetchLinkedInStatsFallback(accessToken, post.platformPostId);
                if (fallbackStats) {
                    await sheets.writeStats('LinkedIn_Posted', post.rowIndex, fallbackStats);
                    console.log(`  -> Fallback succeeded: ${fallbackStats.engagement} engagement`);
                }
            } catch (fallbackError) {
                console.error(`  -> Fallback also failed: ${fallbackError.message}`);
            }
        }
    }
}

/**
 * Fetch a specific metric from LinkedIn memberCreatorPostAnalytics API
 * @param {string} accessToken - LinkedIn access token
 * @param {string} postUrn - The post URN (e.g., urn:li:ugcPost:123)
 * @param {string} metricType - IMPRESSION, REACTION, COMMENT, RESHARE, or MEMBERS_REACHED
 * @returns {number} The metric count
 */
async function fetchLinkedInMetric(accessToken, postUrn, metricType) {
    // Encode the URN for the entity parameter
    // Format: entity=(ugc:urn%3Ali%3AugcPost%3A{id})
    const encodedUrn = encodeURIComponent(postUrn);

    // Determine the entity type prefix based on URN
    let entityPrefix = 'ugc';
    if (postUrn.includes('share')) {
        entityPrefix = 'share';
    }

    const url = `https://api.linkedin.com/rest/memberCreatorPostAnalytics?q=entity&entity=(${entityPrefix}:${encodedUrn})&queryType=${metricType}`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'LinkedIn-Version': '202501',
            'X-Restli-Protocol-Version': '2.0.0'
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LinkedIn API error (${metricType}): ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    // Extract count from response
    // Response format: { elements: [{ count: X, metricType: "IMPRESSION" }] }
    if (data.elements && data.elements.length > 0) {
        return data.elements[0].count || 0;
    }

    return 0;
}

/**
 * Fallback to legacy socialActions API for older posts or if new API fails
 */
async function fetchLinkedInStatsFallback(accessToken, postUrn) {
    const response = await fetch(
        `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(postUrn)}`,
        {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'X-Restli-Protocol-Version': '2.0.0'
            }
        }
    );

    if (!response.ok) {
        throw new Error(`Fallback API error: ${response.status}`);
    }

    const data = await response.json();
    const engagement = (data.likesSummary?.totalLikes || 0) +
        (data.commentsSummary?.totalFirstLevelComments || 0);

    return {
        impressions: 0,
        engagement,
        isWinner: false // Let the main logic determine this
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
