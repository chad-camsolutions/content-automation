/**
 * Post to X (Twitter)
 * Reads pending posts from Google Sheet, posts to X API
 */

const { TwitterApi } = require('twitter-api-v2');
const sheets = require('./sheets-helper');

const BATCH_SIZE = 7; // Posts per run (8 runs/day = 56 posts)

async function main() {
    console.log('Starting X posting batch...');

    // Initialize X client
    const client = new TwitterApi({
        appKey: process.env.X_API_KEY,
        appSecret: process.env.X_API_SECRET,
        accessToken: process.env.X_ACCESS_TOKEN,
        accessSecret: process.env.X_ACCESS_SECRET
    });

    // Get pending posts
    const pending = await sheets.getPendingPosts('X Queue', BATCH_SIZE);
    console.log(`Found ${pending.length} pending posts`);

    if (pending.length === 0) {
        console.log('No pending posts. Add more to the X Queue tab.');
        return;
    }

    // Post each one
    let successCount = 0;
    for (const post of pending) {
        try {
            console.log(`Posting: "${post.content.substring(0, 50)}..."`);

            // Check content length (280 char limit)
            if (post.content.length > 280) {
                console.warn(`Post too long (${post.content.length} chars), truncating...`);
                post.content = post.content.substring(0, 277) + '...';
            }

            // Post to X
            const tweet = await client.v2.tweet(post.content);
            const tweetId = tweet.data.id;

            console.log(`Posted! Tweet ID: ${tweetId}`);

            // Mark as posted in sheet
            await sheets.markAsPosted('X Queue', post.rowIndex, tweetId);
            successCount++;

            // Small delay to avoid rate limits
            await sleep(2000);

        } catch (error) {
            console.error(`Failed to post row ${post.rowIndex}:`, error.message);

            // Check for quota/rate limit errors
            if (error.code === 429 || error.message.includes('rate limit')) {
                console.error('Rate limited! Stopping batch.');
                break;
            }
        }
    }

    console.log(`Batch complete. Posted ${successCount}/${pending.length} successfully.`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
