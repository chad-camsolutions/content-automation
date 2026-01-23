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

            if (isWinner) {
                try {
                    await sheets.copyRowToTab('X Posted', 'X Winners', post.rowIndex);
                    console.log(`  -> 🏆 Winner moved to X Winners`);
                } catch (error) {
                    console.error(`  -> Failed to copy winner: ${error.message}`);
                }
            }

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
            const postUrn = post.platformPostId;
            let stats;

            try {
                // Fetch all stats in one call using the Posts API
                stats = await fetchLinkedInPostStats(accessToken, postUrn);
            } catch (primaryError) {
                console.warn(`Original stats fetch failed for ${postUrn}: ${primaryError.message}. Trying fallback...`);
                try {
                    stats = await fetchLinkedInStatsFallback(accessToken, postUrn);
                } catch (fallbackError) {
                    console.error(`Failed to get stats for ${postUrn} (Primary & Fallback):`, fallbackError.message);
                    continue; // Skip processing this post
                }
            }

            const impressions = stats.impressions;
            const engagement = stats.reactions + stats.comments;
            const isWinner = engagement > 0 && engagement >= winnerThreshold;

            console.log(`Post ${postUrn}: ${impressions} impressions, ${engagement} engagement (${stats.reactions} reactions, ${stats.comments} comments) ${isWinner ? '🏆' : ''}`);

            await sheets.writeStats('LinkedIn Posted', post.rowIndex, {
                impressions,
                engagement,
                isWinner
            });

            if (isWinner) {
                try {
                    await sheets.copyRowToTab('LinkedIn Posted', 'LinkedIn Winners', post.rowIndex);
                    console.log(`  -> 🏆 Winner moved to LinkedIn Winners`);
                } catch (error) {
                    console.error(`  -> Failed to copy winner: ${error.message}`);
                }
            }

            await sleep(1500); // Slightly longer delay for LinkedIn rate limits

        } catch (error) {
            console.error(`Failed to get stats for ${post.platformPostId}:`, error.message);
        }
    }
}

/**
 * Fetch LinkedIn post stats using the Posts API
 * @param {string} accessToken - LinkedIn access token
 * @param {string} postUrn - The post URN (urn:li:share:123 or urn:li:ugcPost:123)
 * @returns {object} Stats object with impressions, reactions, comments
 */
async function fetchLinkedInPostStats(accessToken, postUrn) {
    // Use the Posts API with analytics projection
    const encodedUrn = encodeURIComponent(postUrn);

    // Try the posts API to get the post with analytics
    const url = `https://api.linkedin.com/rest/posts/${encodedUrn}`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'LinkedIn-Version': '202601',
            'X-Restli-Protocol-Version': '2.0.0'
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LinkedIn API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    // Extract stats from response
    return {
        impressions: data.numImpressions || 0,
        reactions: data.numLikes || data.numReactions || 0,
        comments: data.numComments || 0
    };
}



/**
 * Fallback: Fetch stats using socialMetadata (better for urn:li:share)
 */
async function fetchLinkedInStatsFallback(accessToken, postUrn) {
    const encodedUrn = encodeURIComponent(postUrn);
    const url = `https://api.linkedin.com/v2/socialMetadata/${encodedUrn}`;

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0'
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LinkedIn Fallback API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    // Calculate total reactions from summary
    let reactions = 0;
    if (data.reactionSummaries) {
        reactions = Object.values(data.reactionSummaries).reduce((sum, r) => sum + (r.count || 0), 0);
    }

    return {
        impressions: 0, // Not available via socialMetadata
        reactions: reactions,
        comments: data.commentSummary ? (data.commentSummary.count || 0) : 0
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
